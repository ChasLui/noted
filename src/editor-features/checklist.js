import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { activeEditorModeField } from './mode-detector.js';

const CHECK_TRIGGER_REGEX = /\s*\/x\s*$/i;
const HEADING_REGEX = /^#+(?:\s|$)/;

function isChecklistLine(text) {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  return !trimmed.startsWith('//') && !HEADING_REGEX.test(trimmed);
}

function isCheckedLine(text) {
  return CHECK_TRIGGER_REGEX.test(text);
}

class ChecklistBoxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }

  eq(other) {
    // The button only renders the checked state, so reusing its DOM is safe as
    // long as that state is unchanged. Absolute position is intentionally not
    // part of the identity: edits above a line shift it and would otherwise
    // force every checkbox below to rebuild.
    return other.checked === this.checked;
  }

  toDOM(view) {
    const button = document.createElement('button');
    button.className = `checklist-box${this.checked ? ' is-checked' : ''}`;
    button.type = 'button';
    button.tabIndex = -1;
    button.setAttribute('aria-label', this.checked ? 'Mark item unchecked' : 'Mark item checked');
    button.setAttribute('aria-pressed', String(this.checked));

    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Resolve the line from the live DOM: the widget instance may be reused
      // after edits shift its line, so a captured offset would go stale.
      const pos = view.posAtDOM(button);
      toggleChecklistLine(view, view.state.doc.lineAt(pos).from);
      view.focus();
    });

    return button;
  }

  ignoreEvent(event) {
    return event.type === 'mousedown' || event.type === 'mouseup' || event.type === 'click';
  }
}

function toggleChecklistLine(view, lineFrom) {
  if (view.state.readOnly) return;

  const line = view.state.doc.lineAt(lineFrom);
  const match = line.text.match(CHECK_TRIGGER_REGEX);

  if (match) {
    view.dispatch({
      changes: {
        from: line.to - match[0].length,
        to: line.to,
        insert: ''
      }
    });
    return;
  }

  const trailingWhitespace = line.text.match(/\s*$/)[0].length;
  const insertFrom = line.to - trailingWhitespace;
  const marker = line.text.trim() === '' ? '/x' : ' /x';
  view.dispatch({
    changes: {
      from: insertFrom,
      to: line.to,
      insert: marker
    }
  });
}

function buildChecklistDecorations(view) {
  const builder = new RangeSetBuilder();
  if (view.state.field(activeEditorModeField) !== 'list') return builder.finish();

  const doc = view.state.doc;
  let lastLine = 0;

  // Only decorate lines that are actually drawn. The viewport is re-decorated
  // on scroll, so this stays correct while keeping the cost proportional to the
  // visible lines instead of the whole document.
  for (const { from, to } of view.visibleRanges) {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;

    for (let lineNumber = first; lineNumber <= last; lineNumber++) {
      if (lineNumber <= lastLine) continue;
      lastLine = lineNumber;
      const line = doc.line(lineNumber);

      if (lineNumber === 1) {
        const keywordStart = line.from + line.text.search(/\S/);
        if (keywordStart >= line.from) {
          builder.add(
            keywordStart,
            keywordStart + 'list'.length,
            Decoration.mark({ class: 'editor-mode-keyword editor-mode-keyword-list' })
          );
        }
        continue;
      }

      if (!isChecklistLine(line.text)) continue;

      const checked = isCheckedLine(line.text);
      builder.add(
        line.from,
        line.from,
        Decoration.widget({
          widget: new ChecklistBoxWidget(checked),
          side: -1
        })
      );

      if (checked) {
        builder.add(line.from, line.to, Decoration.mark({ class: 'checklist-line-checked' }));
      }
    }
  }

  return builder.finish();
}

export const checklistField = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildChecklistDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildChecklistDecorations(update.view);
    }
  }
}, {
  decorations: (plugin) => plugin.decorations
});
