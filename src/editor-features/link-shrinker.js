import { StateField, StateEffect } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
const MAX_DISPLAY = 28;

const expandLinkEffect = StateEffect.define();

function truncateUrl(url) {
  let display = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const cleaned = display.split('?')[0].split('#')[0];
  const hadQueryOrFragment = cleaned !== display;

  if (hadQueryOrFragment) {
    const pathParts = cleaned.split('/');
    if (pathParts.length <= 2) {
      return pathParts[0] + '/...';
    }
  }

  if (cleaned.length <= MAX_DISPLAY && !hadQueryOrFragment) return cleaned;

  const parts = cleaned.split('/');
  const domain = parts[0];

  if (parts.length === 1) {
    return domain.length > MAX_DISPLAY
      ? domain.slice(0, MAX_DISPLAY - 3) + '...'
      : domain;
  }

  const domainLen = domain.length;
  const firstSeg = parts[1];
  const needed = domainLen + 1 + firstSeg.length + 4;

  if (needed <= MAX_DISPLAY) {
    return domain + '/' + firstSeg + '/...';
  }

  const budget = MAX_DISPLAY - domain.length - 4;
  if (budget > 0) {
    return domain + '/' + firstSeg.slice(0, budget) + '...';
  }

  return domain.length > MAX_DISPLAY - 4
    ? domain.slice(0, MAX_DISPLAY - 4) + '/...'
    : domain + '/...';
}

function findUrlsInText(text, offset) {
  const results = [];
  URL_REGEX.lastIndex = 0;
  let match;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const url = match[0];
    const stripped = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (stripped !== url) {
      results.push({
        from: offset + match.index,
        to: offset + match.index + url.length,
        url
      });
    }
  }
  return results;
}

// A URL can never contain whitespace, so a match always stays inside one line.
// Scanning a line at a time is therefore equivalent to scanning the whole
// document, but lets us re-scan only the lines an edit actually touched.
function collectLineLinks(line, expanded, target) {
  for (const { from, to, url } of findUrlsInText(line.text, line.from)) {
    const expandedLink = expanded.get(from);
    if (expandedLink?.to === to && expandedLink.url === url) continue;
    target.set(from, { to, url });
  }
}

function scanDocument(doc, expanded) {
  const links = new Map();
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    collectLineLinks(doc.line(lineNumber), expanded, links);
  }
  return links;
}

function collectChanges(transaction) {
  const changes = [];
  transaction.changes.iterChanges((fromA, toA, fromB, toB) => {
    changes.push({ fromA, toA, fromB, toB });
  });
  return changes;
}

// The lines an edit can affect, with one line of slack on each side. A URL can
// change on the edited line, and inserting or deleting a line break can join a
// URL with the text on a neighbouring line. The slack also absorbs positions
// that fall inside a multi-character line break (for example `\r\n`).
function dirtyLineBounds(doc, changes, fromKey, toKey) {
  let start = Infinity;
  let end = -Infinity;
  for (const change of changes) {
    const from = Math.max(0, change[fromKey] - 1);
    const to = Math.min(doc.length, change[toKey] + 1);
    start = Math.min(start, doc.lineAt(from).number);
    end = Math.max(end, doc.lineAt(to).number);
  }
  return { start, end };
}

function mapExpanded(expanded, changes, transaction) {
  const next = new Map();
  for (const [oldFrom, { to: oldTo, url }] of expanded) {
    let overlaps = false;
    for (const { fromA, toA } of changes) {
      if (oldFrom < toA && oldTo > fromA) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    next.set(
      transaction.changes.mapPos(oldFrom, 1),
      { to: transaction.changes.mapPos(oldTo, -1), url }
    );
  }
  return next;
}

function createShrunkLinkState(state, expanded = new Map()) {
  return { links: scanDocument(state.doc, expanded), expanded };
}

class ShrunkLinkWidget extends WidgetType {
  constructor(display, url) {
    super();
    this.display = display;
    this.url = url;
  }

  eq(other) {
    return other.display === this.display && other.url === this.url;
  }

  toDOM(view) {
    const span = document.createElement('span');
    span.className = 'shrunk-link';
    span.textContent = this.display;
    span.title = this.url;
    span.dataset.url = this.url;

    span.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey || e.metaKey) {
        const pos = view.posAtDOM(span);
        view.dispatch({
          effects: expandLinkEffect.of(pos)
        });
      } else {
        openExternalUrl(this.url);
      }
    });

    return span;
  }

  ignoreEvent(event) {
    return event.type === 'mousedown' || event.type === 'mouseup' || event.type === 'click';
  }
}

function openExternalUrl(url) {
  try {
    const opener = window.__TAURI__?.opener;
    if (opener?.openUrl) {
      Promise.resolve(opener.openUrl(url)).catch(() => {
        window.open(url, '_blank');
      });
    } else {
      window.open(url, '_blank');
    }
  } catch {
    window.open(url, '_blank');
  }
}

const shrunkLinksField = StateField.define({
  create(state) {
    return createShrunkLinkState(state);
  },

  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(expandLinkEffect)) {
        const pos = effect.value;
        for (const [from, info] of value.links) {
          if (from <= pos && info.to >= pos) {
            const links = new Map(value.links);
            const expanded = new Map(value.expanded);
            links.delete(from);
            expanded.set(from, info);
            return { links, expanded };
          }
        }
        return value;
      }
    }

    if (!transaction.docChanged) return value;

    const changes = collectChanges(transaction);
    if (changes.length === 0) return value;

    const oldDoc = transaction.startState.doc;
    const newDoc = transaction.state.doc;
    const oldBounds = dirtyLineBounds(oldDoc, changes, 'fromA', 'toA');
    const newBounds = dirtyLineBounds(newDoc, changes, 'fromB', 'toB');

    const expanded = mapExpanded(value.expanded, changes, transaction);

    // Links on untouched lines keep their text, so shift their positions and
    // keep them. Links on touched lines are dropped and re-discovered below.
    const links = new Map();
    for (const [oldFrom, info] of value.links) {
      const lineNumber = oldDoc.lineAt(oldFrom).number;
      if (lineNumber >= oldBounds.start && lineNumber <= oldBounds.end) continue;
      links.set(
        transaction.changes.mapPos(oldFrom, 1),
        { to: transaction.changes.mapPos(info.to, -1), url: info.url }
      );
    }

    for (let lineNumber = newBounds.start; lineNumber <= newBounds.end; lineNumber++) {
      collectLineLinks(newDoc.line(lineNumber), expanded, links);
    }

    // Nothing linked before or after: keep the previous state so dependants
    // such as the decoration provider are not recomputed.
    if (
      links.size === 0 &&
      expanded.size === 0 &&
      value.links.size === 0 &&
      value.expanded.size === 0
    ) {
      return value;
    }

    return { links, expanded };
  },

  provide(field) {
    return EditorView.decorations.compute([field], (state) => {
      const shrunk = state.field(field).links;
      const decos = [];
      for (const [from, { to, url }] of shrunk) {
        decos.push(Decoration.replace({
          widget: new ShrunkLinkWidget(truncateUrl(url), url)
        }).range(from, to));
      }
      return Decoration.set(decos, true);
    });
  }
});

export { shrunkLinksField, expandLinkEffect };
