import type { ReactNode } from 'react';
import {
  $applyNodeReplacement,
  DecoratorNode,
  ElementNode,
  type DOMExportOutput,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';

export type PrintBlockKind = 'title' | 'note' | 'glossary' | 'custom' | 'ai-result';

export type SerializedPrintBlockNode = Spread<
  {
    sourceId: string;
    label: string;
    blockKind: PrintBlockKind;
    hidden: boolean;
  },
  SerializedElementNode
>;

export class PrintBlockNode extends ElementNode {
  __sourceId: string;
  __label: string;
  __blockKind: PrintBlockKind;
  __hidden: boolean;

  static getType(): string {
    return 'print-block';
  }

  static clone(node: PrintBlockNode): PrintBlockNode {
    return new PrintBlockNode(
      node.__sourceId,
      node.__label,
      node.__blockKind,
      node.__hidden,
      node.__key,
    );
  }

  static importJSON(serialized: SerializedPrintBlockNode): PrintBlockNode {
    return $createPrintBlockNode(
      serialized.sourceId,
      serialized.label,
      serialized.blockKind,
      serialized.hidden,
    ).updateFromJSON(serialized);
  }

  constructor(
    sourceId: string,
    label: string,
    blockKind: PrintBlockKind,
    hidden = false,
    key?: NodeKey,
  ) {
    super(key);
    this.__sourceId = sourceId;
    this.__label = label;
    this.__blockKind = blockKind;
    this.__hidden = hidden;
  }

  createDOM(): HTMLElement {
    const element = document.createElement('article');
    element.className = `print-composer-block print-block-${this.__blockKind}`;
    element.dataset.sourceId = this.__sourceId;
    element.dataset.blockKind = this.__blockKind;
    element.hidden = this.__hidden;
    return element;
  }

  updateDOM(previous: PrintBlockNode, element: HTMLElement): boolean {
    if (previous.__blockKind !== this.__blockKind) {
      element.className = `print-composer-block print-block-${this.__blockKind}`;
      element.dataset.blockKind = this.__blockKind;
    }
    if (previous.__sourceId !== this.__sourceId)
      element.dataset.sourceId = this.__sourceId;
    element.hidden = this.__hidden;
    return false;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    if (this.__hidden) return { element: null };
    const output = super.exportDOM(editor);
    if (output.element instanceof HTMLElement) {
      output.element.className = `print-composer-block print-block-${this.__blockKind}`;
      output.element.dataset.sourceId = this.__sourceId;
      output.element.dataset.blockKind = this.__blockKind;
    }
    return output;
  }

  exportJSON(): SerializedPrintBlockNode {
    return {
      ...super.exportJSON(),
      type: 'print-block',
      version: 1,
      sourceId: this.__sourceId,
      label: this.__label,
      blockKind: this.__blockKind,
      hidden: this.__hidden,
    };
  }

  updateFromJSON(serialized: LexicalUpdateJSON<SerializedPrintBlockNode>): this {
    super.updateFromJSON(serialized);
    const writable = this.getWritable();
    writable.__sourceId = serialized.sourceId;
    writable.__label = serialized.label;
    writable.__blockKind = serialized.blockKind;
    writable.__hidden = serialized.hidden;
    return this;
  }

  getSourceId(): string {
    return this.getLatest().__sourceId;
  }

  getLabel(): string {
    return this.getLatest().__label;
  }

  getBlockKind(): PrintBlockKind {
    return this.getLatest().__blockKind;
  }

  isHidden(): boolean {
    return this.getLatest().__hidden;
  }

  setHidden(hidden: boolean): this {
    this.getWritable().__hidden = hidden;
    return this;
  }

  canBeEmpty(): boolean {
    return false;
  }
}

export type SerializedPageBreakNode = SerializedLexicalNode;

export class PageBreakNode extends DecoratorNode<ReactNode> {
  static getType(): string {
    return 'print-page-break';
  }

  static clone(node: PageBreakNode): PageBreakNode {
    return new PageBreakNode(node.__key);
  }

  static importJSON(): PageBreakNode {
    return $createPageBreakNode();
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'print-page-break';
    element.setAttribute('aria-label', 'Manual page break');
    return element;
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div');
    element.className = 'print-page-break';
    return { element };
  }

  exportJSON(): SerializedPageBreakNode {
    return { type: 'print-page-break', version: 1 };
  }

  decorate(): ReactNode {
    return <span className="print-page-break-label">Page break</span>;
  }
}

export function $createPrintBlockNode(
  sourceId: string,
  label: string,
  kind: PrintBlockKind,
  hidden = false,
): PrintBlockNode {
  return $applyNodeReplacement(new PrintBlockNode(sourceId, label, kind, hidden));
}

export function $isPrintBlockNode(
  node: LexicalNode | null | undefined,
): node is PrintBlockNode {
  return node instanceof PrintBlockNode;
}

export function $createPageBreakNode(): PageBreakNode {
  return $applyNodeReplacement(new PageBreakNode());
}
