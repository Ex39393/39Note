import { useCallback, useEffect, useRef, useState } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import {
  HorizontalRuleNode,
  INSERT_HORIZONTAL_RULE_COMMAND,
} from '@lexical/react/LexicalHorizontalRuleNode';
import { HorizontalRulePlugin } from '@lexical/react/LexicalHorizontalRulePlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $patchStyleText, $setBlocksType } from '@lexical/selection';
import { LinkNode, AutoLinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  HeadingNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  INSERT_TABLE_COMMAND,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import { $insertNodeToNearestRoot, mergeRegister } from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import type { Note } from '../types/note';
import type { GlossaryEntry, NotesPrintLayout } from '../types/glossary';
import type { PdfAnnotation } from '../types/highlight';
import type { PrintDraftAddition } from '../types/productivity';
import { getAllAnnotationsPrintContent } from '../utils/annotationPrint';
import { getDictionaryAttributionText } from '../utils/dictionary';
import {
  $createPageBreakNode,
  $createPrintBlockNode,
  $isPrintBlockNode,
  PageBreakNode,
  PrintBlockNode,
  type PrintBlockKind,
} from './PrintNodes';

interface PrintComposerEditorProps {
  documentTitle: string;
  notes: readonly Note[];
  annotations: readonly PdfAnnotation[];
  glossaryEntries: readonly GlossaryEntry[];
  layout: NotesPrintLayout;
  initialEditorStateJson: string;
  pendingAdditions: readonly PrintDraftAddition[];
  onPendingAdditionsConsumed: () => void;
  onChange: (editorStateJson: string) => void;
  onReady: (editor: LexicalEditor) => void;
}

export function PrintComposerEditor({
  documentTitle,
  notes,
  annotations,
  glossaryEntries,
  layout,
  initialEditorStateJson,
  pendingAdditions,
  onPendingAdditionsConsumed,
  onChange,
  onReady,
}: PrintComposerEditorProps) {
  const initialConfig = {
    namespace: '39NotePrintComposer',
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      LinkNode,
      AutoLinkNode,
      TableNode,
      TableCellNode,
      TableRowNode,
      HorizontalRuleNode,
      PrintBlockNode,
      PageBreakNode,
    ],
    theme: {
      paragraph: 'print-editor-paragraph',
      quote: 'print-editor-quote',
      heading: {
        h1: 'print-editor-h1',
        h2: 'print-editor-h2',
        h3: 'print-editor-h3',
      },
      list: {
        ol: 'print-editor-ol',
        ul: 'print-editor-ul',
        listitem: 'print-editor-list-item',
        nested: { listitem: 'print-editor-nested-list-item' },
      },
      link: 'print-editor-link',
      table: 'print-editor-table',
      tableCell: 'print-editor-table-cell',
      tableCellHeader: 'print-editor-table-header',
    },
    editorState: initialEditorStateJson || undefined,
    onError(error: Error) {
      throw error;
    },
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <EditorBridge onReady={onReady} />
      <InitialContentPlugin
        documentTitle={documentTitle}
        notes={notes}
        annotations={annotations}
        glossaryEntries={glossaryEntries}
        layout={layout}
        pendingAdditions={pendingAdditions}
        onPendingAdditionsConsumed={onPendingAdditionsConsumed}
      />
      <PrintEditorToolbar />
      <div className="print-editor-workspace">
        <PrintBlockManager />
        <div className="print-editor-canvas-shell">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                aria-label="Editable print draft"
                className="print-editor-content"
                spellCheck
              />
            }
            ErrorBoundary={({ children }) => children}
          />
          <HistoryPlugin />
          <ListPlugin />
          <LinkPlugin />
          <TablePlugin hasCellMerge={false} hasCellBackgroundColor />
          <HorizontalRulePlugin />
          <OnChangePlugin
            ignoreSelectionChange
            onChange={(editorState) => onChange(JSON.stringify(editorState.toJSON()))}
          />
        </div>
      </div>
    </LexicalComposer>
  );
}

function EditorBridge({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

function InitialContentPlugin({
  documentTitle,
  notes,
  annotations,
  glossaryEntries,
  layout,
  pendingAdditions,
  onPendingAdditionsConsumed,
}: {
  documentTitle: string;
  notes: readonly Note[];
  annotations: readonly PdfAnnotation[];
  glossaryEntries: readonly GlossaryEntry[];
  layout: NotesPrintLayout;
  pendingAdditions: readonly PrintDraftAddition[];
  onPendingAdditionsConsumed: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    editor.update(() => {
      const root = $getRoot();
      const hasOnlyEmptyDefaultContent =
        root.getTextContent().trim() === '' &&
        root.getChildren().every((node) => $isElementNode(node) && node.isEmpty());
      if (root.isEmpty() || hasOnlyEmptyDefaultContent) {
        root.clear();
        root.append(createTitleBlock(documentTitle));
        if (layout === 'all-annotations') {
          const content = getAllAnnotationsPrintContent(annotations, notes);
          for (const item of content.annotationItems) {
            root.append(createAnnotationBlock(item.annotation, item.notes));
          }
          for (const note of content.standaloneNotes) {
            root.append(createNoteBlock(note));
          }
        } else {
          for (const note of notes) root.append(createNoteBlock(note));
        }
        for (const entry of glossaryEntries) root.append(createGlossaryBlock(entry));
        if (glossaryEntries.length > 0) {
          root.append(createGlossaryAttributionBlock(glossaryEntries));
        }
      }
      for (const addition of pendingAdditions) {
        root.append(createAdditionBlock(addition));
      }
    });
    if (pendingAdditions.length) onPendingAdditionsConsumed();
  }, [
    annotations,
    documentTitle,
    editor,
    glossaryEntries,
    layout,
    notes,
    onPendingAdditionsConsumed,
    pendingAdditions,
  ]);
  return null;
}

function PrintEditorToolbar() {
  const [editor] = useLexicalComposerContext();
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    superscript: false,
    subscript: false,
  });
  const updateActiveFormats = useCallback(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    setActiveFormats({
      bold: selection.hasFormat('bold'),
      italic: selection.hasFormat('italic'),
      underline: selection.hasFormat('underline'),
      strikethrough: selection.hasFormat('strikethrough'),
      superscript: selection.hasFormat('superscript'),
      subscript: selection.hasFormat('subscript'),
    });
  }, []);
  useEffect(
    () =>
      mergeRegister(
        editor.registerUpdateListener(({ editorState }) => {
          editorState.read(updateActiveFormats);
        }),
        editor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          () => {
            updateActiveFormats();
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          CAN_UNDO_COMMAND,
          (available) => {
            setCanUndo(available);
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          CAN_REDO_COMMAND,
          (available) => {
            setCanRedo(available);
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
      ),
    [editor, updateActiveFormats],
  );
  const patchTextStyle = (style: Record<string, string | null>) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $patchStyleText(selection, style);
    });
  };
  const setBlockType = (type: 'paragraph' | 'h1' | 'h2' | 'h3' | 'quote') => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      $setBlocksType(selection, () =>
        type === 'paragraph'
          ? $createParagraphNode()
          : type === 'quote'
            ? $createQuoteNode()
            : $createHeadingNode(type),
      );
    });
  };
  const applyBlockStyle = (property: string, value: string) => {
    editor.update(() => {
      for (const block of getSelectedBlocks()) {
        block.setStyle(updateStyle(block.getStyle(), property, value));
      }
    });
  };
  const clearFormatting = () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      selection.setFormat(0);
      selection.setStyle('');
      for (const node of selection.getNodes()) {
        if ($isTextNode(node)) {
          node.setFormat(0);
          node.setStyle('');
        }
      }
      for (const block of getSelectedBlocks()) {
        block.setStyle('');
        block.setFormat('');
        block.setIndent(0);
      }
    });
  };
  const editLink = () => {
    const url = window.prompt(
      'Link URL (https://, http://, mailto:, or #):',
      'https://',
    );
    if (url === null) return;
    const trimmed = url.trim();
    if (trimmed && !/^(https?:|mailto:|#)/i.test(trimmed)) {
      return;
    }
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, trimmed || null);
  };

  return (
    <div className="print-editor-toolbar" role="toolbar" aria-label="Print formatting">
      <div className="print-toolbar-group">
        <button
          aria-label="Undo"
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          type="button"
          onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
        >
          ↶
        </button>
        <button
          aria-label="Redo"
          disabled={!canRedo}
          title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
          type="button"
          onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
        >
          ↷
        </button>
        <button type="button" onClick={clearFormatting}>
          Clear formatting
        </button>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.readText().then((text) => {
              editor.update(() => {
                const selection = $getSelection();
                if ($isRangeSelection(selection)) selection.insertRawText(text);
              });
            })
          }
        >
          Paste plain text
        </button>
      </div>
      <div className="print-toolbar-group">
        <button
          aria-label="Bold"
          aria-pressed={activeFormats.bold}
          title="Bold (Ctrl+B)"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
        >
          <strong>B</strong>
        </button>
        <button
          aria-label="Italic"
          aria-pressed={activeFormats.italic}
          title="Italic (Ctrl+I)"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}
        >
          <em>I</em>
        </button>
        <button
          aria-label="Underline"
          aria-pressed={activeFormats.underline}
          title="Underline (Ctrl+U)"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}
        >
          <u>U</u>
        </button>
        <button
          aria-label="Strikethrough"
          aria-pressed={activeFormats.strikethrough}
          title="Strikethrough"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough')}
        >
          <s>S</s>
        </button>
        <button
          aria-label="Superscript"
          aria-pressed={activeFormats.superscript}
          title="Superscript"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'superscript')}
        >
          x²
        </button>
        <button
          aria-label="Subscript"
          aria-pressed={activeFormats.subscript}
          title="Subscript"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'subscript')}
        >
          x₂
        </button>
        <label>
          <span className="visually-hidden">Font family</span>
          <select
            aria-label="Font family"
            defaultValue="Georgia"
            onChange={(event) => patchTextStyle({ 'font-family': event.target.value })}
          >
            <option value="Georgia, serif">Georgia</option>
            <option value="Arial, sans-serif">Arial</option>
            <option value="'Times New Roman', serif">Times New Roman</option>
            <option value="Verdana, sans-serif">Verdana</option>
            <option value="'Courier New', monospace">Courier New</option>
          </select>
        </label>
        <label>
          <span className="visually-hidden">Font size</span>
          <select
            aria-label="Font size"
            defaultValue="12pt"
            onChange={(event) => patchTextStyle({ 'font-size': event.target.value })}
          >
            {[8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 40, 48].map((size) => (
              <option key={size} value={`${size}pt`}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <label className="print-color-control">
          Text
          <input
            aria-label="Text colour"
            type="color"
            defaultValue="#171717"
            onChange={(event) => patchTextStyle({ color: event.target.value })}
          />
        </label>
        <label className="print-color-control">
          Highlight
          <input
            aria-label="Text highlight colour"
            type="color"
            defaultValue="#fff59d"
            onChange={(event) =>
              patchTextStyle({ 'background-color': event.target.value })
            }
          />
        </label>
      </div>
      <div className="print-toolbar-group">
        <select
          aria-label="Paragraph style"
          defaultValue="paragraph"
          onChange={(event) =>
            setBlockType(
              event.target.value as 'paragraph' | 'h1' | 'h2' | 'h3' | 'quote',
            )
          }
        >
          <option value="paragraph">Normal</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="quote">Block quote</option>
        </select>
        <button
          aria-label="Align left"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left')}
        >
          Left
        </button>
        <button
          aria-label="Align centre"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center')}
        >
          Centre
        </button>
        <button
          aria-label="Align right"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right')}
        >
          Right
        </button>
        <button
          aria-label="Justify"
          type="button"
          onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'justify')}
        >
          Justify
        </button>
        <button
          aria-label="Decrease indent"
          type="button"
          onClick={() => editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined)}
        >
          Outdent
        </button>
        <button
          aria-label="Increase indent"
          type="button"
          onClick={() => editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined)}
        >
          Indent
        </button>
        <select
          aria-label="Line spacing"
          defaultValue="1.5"
          onChange={(event) => applyBlockStyle('line-height', event.target.value)}
        >
          <option value="1">Single</option>
          <option value="1.15">1.15</option>
          <option value="1.5">1.5</option>
          <option value="2">Double</option>
        </select>
        <select
          aria-label="Paragraph spacing before"
          defaultValue="0pt"
          onChange={(event) => applyBlockStyle('margin-top', event.target.value)}
        >
          <option value="0pt">Before 0</option>
          <option value="6pt">Before 6</option>
          <option value="12pt">Before 12</option>
          <option value="18pt">Before 18</option>
        </select>
        <select
          aria-label="Paragraph spacing after"
          defaultValue="10pt"
          onChange={(event) => applyBlockStyle('margin-bottom', event.target.value)}
        >
          <option value="0pt">After 0</option>
          <option value="6pt">After 6</option>
          <option value="10pt">After 10</option>
          <option value="18pt">After 18</option>
        </select>
        <button
          type="button"
          onClick={() => {
            applyBlockStyle('break-after', 'avoid-page');
            applyBlockStyle('page-break-after', 'avoid');
          }}
        >
          Keep with next
        </button>
      </div>
      <div className="print-toolbar-group">
        <button
          type="button"
          onClick={() =>
            editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
          }
        >
          Bullets
        </button>
        <button
          type="button"
          onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}
        >
          Numbering
        </button>
        <button
          type="button"
          onClick={() => editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined)}
        >
          Remove list
        </button>
        <button type="button" onClick={editLink}>
          Add/edit link
        </button>
        <button
          type="button"
          onClick={() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)}
        >
          Remove link
        </button>
        <button
          type="button"
          onClick={() =>
            editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined)
          }
        >
          Horizontal rule
        </button>
        <button
          type="button"
          onClick={() =>
            editor.update(() => $insertNodeToNearestRoot($createPageBreakNode()))
          }
        >
          Page break
        </button>
        <button
          type="button"
          onClick={() =>
            editor.dispatchCommand(INSERT_TABLE_COMMAND, {
              columns: '3',
              rows: '3',
              includeHeaders: { rows: true, columns: false },
            })
          }
        >
          Insert table
        </button>
        <button
          type="button"
          onClick={() => editor.update(() => void $insertTableRowAtSelection(true))}
        >
          Add row
        </button>
        <button
          type="button"
          onClick={() => editor.update(() => $deleteTableRowAtSelection())}
        >
          Remove row
        </button>
        <button
          type="button"
          onClick={() => editor.update(() => void $insertTableColumnAtSelection(true))}
        >
          Add column
        </button>
        <button
          type="button"
          onClick={() => editor.update(() => $deleteTableColumnAtSelection())}
        >
          Remove column
        </button>
      </div>
    </div>
  );
}

interface BlockSummary {
  sourceId: string;
  label: string;
  kind: PrintBlockKind;
  hidden: boolean;
}

function PrintBlockManager() {
  const [editor] = useLexicalComposerContext();
  const [blocks, setBlocks] = useState<BlockSummary[]>([]);
  const draggedIdRef = useRef<string | null>(null);
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          setBlocks(
            $getRoot()
              .getChildren()
              .filter($isPrintBlockNode)
              .map((block) => ({
                sourceId: block.getSourceId(),
                label: block.getLabel(),
                kind: block.getBlockKind(),
                hidden: block.isHidden(),
              })),
          );
        });
      }),
    [editor],
  );
  const toggle = (sourceId: string, hidden: boolean) => {
    editor.update(() => {
      const block = $getRoot()
        .getChildren()
        .find((node) => $isPrintBlockNode(node) && node.getSourceId() === sourceId);
      if ($isPrintBlockNode(block)) block.setHidden(hidden);
    });
  };
  const appendCustomBlock = (kind: 'text' | 'heading') => {
    const value = window.prompt(kind === 'heading' ? 'Heading text:' : 'Custom text:');
    if (!value?.trim()) return;
    editor.update(() => {
      const block = $createPrintBlockNode(
        crypto.randomUUID(),
        kind === 'heading' ? value.trim() : 'Custom text',
        'custom',
      );
      const content =
        kind === 'heading' ? $createHeadingNode('h2') : $createParagraphNode();
      content.append($createTextNode(value.trim()));
      block.append(content);
      $getRoot().append(block);
      content.selectEnd();
    });
  };
  return (
    <aside className="print-block-manager" aria-label="Print blocks">
      <h3>Print blocks</h3>
      <p>Drag to reorder. Hidden blocks remain in this draft.</p>
      <div className="print-block-add-actions">
        <button type="button" onClick={() => appendCustomBlock('text')}>
          Add text
        </button>
        <button type="button" onClick={() => appendCustomBlock('heading')}>
          Add heading
        </button>
        <button
          type="button"
          onClick={() => editor.update(() => $getRoot().append($createPageBreakNode()))}
        >
          Add page break
        </button>
      </div>
      <ol className="print-block-list">
        {blocks.map((block) => (
          <li
            className={block.hidden ? 'is-hidden' : ''}
            draggable
            key={block.sourceId}
            onDragStart={() => {
              draggedIdRef.current = block.sourceId;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              const draggedId = draggedIdRef.current;
              draggedIdRef.current = null;
              if (!draggedId || draggedId === block.sourceId) return;
              editor.update(() => {
                const root = $getRoot();
                const source = root
                  .getChildren()
                  .find(
                    (node) =>
                      $isPrintBlockNode(node) && node.getSourceId() === draggedId,
                  );
                const target = root
                  .getChildren()
                  .find(
                    (node) =>
                      $isPrintBlockNode(node) && node.getSourceId() === block.sourceId,
                  );
                if ($isPrintBlockNode(source) && $isPrintBlockNode(target))
                  target.insertBefore(source);
              });
            }}
          >
            <span aria-hidden="true">⋮⋮</span>
            <span title={block.label}>{block.label}</span>
            <button type="button" onClick={() => toggle(block.sourceId, !block.hidden)}>
              {block.hidden ? 'Restore' : 'Hide'}
            </button>
          </li>
        ))}
      </ol>
      {blocks.some((block) => block.hidden) ? (
        <button
          type="button"
          onClick={() =>
            blocks
              .filter((block) => block.hidden)
              .forEach((block) => toggle(block.sourceId, false))
          }
        >
          Restore all hidden
        </button>
      ) : null}
    </aside>
  );
}

function getSelectedBlocks(): ElementNode[] {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return [];
  const blocks = new Map<string, ElementNode>();
  for (const selectedNode of selection.getNodes()) {
    let node: LexicalNode | null = selectedNode;
    while (node && !$isPrintBlockNode(node.getParent())) node = node.getParent();
    if ($isElementNode(node) && !$isPrintBlockNode(node))
      blocks.set(node.getKey(), node);
  }
  return [...blocks.values()];
}

function updateStyle(style: string, property: string, value: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const without = style.replace(
    new RegExp(`(?:^|;)\\s*${escaped}\\s*:[^;]*;?`, 'gi'),
    ';',
  );
  return `${without.replace(/^;+|;+$/g, '')}${without.trim() ? ';' : ''}${property}: ${value};`;
}

function createTitleBlock(title: string): PrintBlockNode {
  const block = $createPrintBlockNode('document-title', 'Document title', 'title');
  const heading = $createHeadingNode('h1');
  heading.append($createTextNode(title));
  const date = $createParagraphNode();
  date.append($createTextNode(`Print draft · ${new Date().toLocaleDateString()}`));
  block.append(heading, date);
  return block;
}

function createNoteBlock(note: Note): PrintBlockNode {
  const label = `Note ${note.displayNumber || note.pageNumber}`;
  const block = $createPrintBlockNode(`note:${note.id}`, label, 'note');
  const heading = $createHeadingNode('h2');
  heading.append($createTextNode(label));
  const source = $createQuoteNode();
  source.append($createTextNode(note.selectedText || 'Source text unavailable'));
  const body = $createParagraphNode();
  body.append($createTextNode(note.content || ''));
  const page = $createParagraphNode();
  page.append($createTextNode(`Page ${note.pageNumber}`));
  block.append(heading, source, body, page);
  return block;
}

function createAnnotationBlock(
  annotation: PdfAnnotation,
  notes: readonly Note[],
): PrintBlockNode {
  const typeLabel = annotation.type === 'highlight' ? 'Highlight' : 'Underline';
  const label = `${typeLabel} · Page ${annotation.pageNumber}`;
  const block = $createPrintBlockNode(
    `annotation:${annotation.id}`,
    label,
    'annotation',
  );
  const heading = $createHeadingNode('h2');
  heading.append($createTextNode(label));
  const source = $createQuoteNode();
  source.append($createTextNode(annotation.text || 'Source text unavailable'));
  block.append(heading, source);
  for (const note of notes) {
    const paragraph = $createParagraphNode();
    const noteLabel = $createTextNode(
      `${note.displayNumber.trim() || 'Note'}. `,
    );
    noteLabel.toggleFormat('bold');
    paragraph.append(noteLabel, $createTextNode(note.content));
    block.append(paragraph);
  }
  return block;
}

function createGlossaryBlock(entry: GlossaryEntry): PrintBlockNode {
  const block = $createPrintBlockNode(
    `glossary:${entry.glossaryEntryId}`,
    entry.displayedWord,
    'glossary',
  );
  const definition = $createParagraphNode();
  const term = $createTextNode(entry.displayedWord);
  term.toggleFormat('bold');
  definition.append(term, $createTextNode(`: ${entry.definition}`));
  block.append(definition);
  return block;
}

function createGlossaryAttributionBlock(
  entries: readonly GlossaryEntry[],
): PrintBlockNode {
  const block = $createPrintBlockNode(
    'glossary-attribution',
    'Dictionary attribution',
    'glossary',
  );
  const paragraph = $createParagraphNode();
  paragraph.append(
    $createTextNode(
      getDictionaryAttributionText(entries.map((entry) => entry.source)),
    ),
  );
  block.append(paragraph);
  return block;
}

function createAdditionBlock(addition: PrintDraftAddition): PrintBlockNode {
  const block = $createPrintBlockNode(
    `addition:${addition.id}`,
    addition.label || 'Added content',
    addition.kind === 'ai-result' ? 'ai-result' : 'custom',
  );
  const heading = $createHeadingNode('h2');
  heading.append($createTextNode(addition.label || 'Added content'));
  block.append(heading);
  for (const paragraphText of addition.content.split(/\n{2,}/)) {
    const paragraph = $createParagraphNode();
    paragraph.append($createTextNode(paragraphText));
    block.append(paragraph);
  }
  return block;
}
