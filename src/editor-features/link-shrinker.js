import { StateField, StateEffect } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
const MAX_DISPLAY = 28;

const expandLinkEffect = StateEffect.define();

function createShrunkLinkState(state, expanded = new Map()) {
  const map = new Map();
  for (const { from, to, url } of findUrlsInText(state.doc.toString(), 0)) {
    const expandedLink = expanded.get(from);
    if (expandedLink?.to === to && expandedLink.url === url) continue;
    map.set(from, { to, url });
  }
  return { links: map, expanded };
}

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

    const expanded = new Map();
    for (const [oldFrom, { to: oldTo, url }] of value.expanded) {
      let overlaps = false;
      transaction.changes.iterChanges((fromA, toA) => {
        if (oldFrom < toA && oldTo > fromA) overlaps = true;
      });
      if (!overlaps) {
        expanded.set(
          transaction.changes.mapPos(oldFrom, 1),
          { to: transaction.changes.mapPos(oldTo, -1), url }
        );
      }
    }

    return createShrunkLinkState(transaction.state, expanded);
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
      return Decoration.set(decos);
    });
  }
});

export { shrunkLinksField, expandLinkEffect };
