// Lexical-based markdown editor.
//
// Storage stays markdown (the DB column is `TEXT` markdown — see
// docs/operations.md and the FTS5 index). Lexical's native EditorState is
// a JSON tree of LexicalNode instances; we translate at the I/O boundary
// using `@lexical/markdown`:
//
//   load:  external `value` (md string)  →  $convertFromMarkdownString
//   save:  EditorState                    →  $convertToMarkdownString  →  onChange(md)
//
// Markdown shortcuts (`# ` → h1, `**foo**` → bold, ``` ``` → code block)
// run live thanks to `MarkdownShortcutPlugin`. The toolbar uses our
// shadcn `Button` + Lucide icons + the project's react-i18next keys, so
// the look matches the rest of the SPA.

import type { ElementNode } from "lexical";

import type { JSX } from "react";
import { $createCodeNode, CodeHighlightNode, CodeNode, registerCodeHighlighting } from "@lexical/code";
import { LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { INSERT_CHECK_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode } from "@lexical/list";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from "@lexical/markdown";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import { mergeRegister } from "@lexical/utils";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
} from "lexical";
import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/lib/utils";

import "./lexical-editor.css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";

interface LexicalMarkdownEditorProps {
  readonly value?: string | undefined;
  readonly defaultValue?: string | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly minHeight?: number | undefined;
}

// Lexical's `theme` is a class-name map applied to nodes — we wire it to
// our Tailwind classes so headings / lists / code look right out of the
// box. Anything not specified falls back to the browser default.
const editorTheme = {
  paragraph: "lex-p",
  heading: {
    h1: "lex-h1",
    h2: "lex-h2",
    h3: "lex-h3",
    h4: "lex-h4",
    h5: "lex-h5",
    h6: "lex-h6",
  },
  list: {
    nested: { listitem: "lex-li-nested" },
    ol: "lex-ol",
    ul: "lex-ul",
    listitem: "lex-li",
    listitemChecked: "lex-li-checked",
    listitemUnchecked: "lex-li-unchecked",
  },
  link: "lex-link",
  text: {
    bold: "lex-bold",
    italic: "lex-italic",
    underline: "lex-underline",
    strikethrough: "lex-strike",
    code: "lex-code-inline",
  },
  code: "lex-code-block",
  codeHighlight: {
    "atrule": "lex-tok-atrule",
    "attr": "lex-tok-attr",
    "boolean": "lex-tok-boolean",
    "builtin": "lex-tok-builtin",
    "cdata": "lex-tok-cdata",
    "char": "lex-tok-char",
    "class": "lex-tok-class",
    "class-name": "lex-tok-class-name",
    "comment": "lex-tok-comment",
    "constant": "lex-tok-constant",
    "deleted": "lex-tok-deleted",
    "doctype": "lex-tok-doctype",
    "entity": "lex-tok-entity",
    "function": "lex-tok-function",
    "important": "lex-tok-important",
    "inserted": "lex-tok-inserted",
    "keyword": "lex-tok-keyword",
    "namespace": "lex-tok-namespace",
    "number": "lex-tok-number",
    "operator": "lex-tok-operator",
    "prolog": "lex-tok-prolog",
    "property": "lex-tok-property",
    "punctuation": "lex-tok-punctuation",
    "regex": "lex-tok-regex",
    "selector": "lex-tok-selector",
    "string": "lex-tok-string",
    "symbol": "lex-tok-symbol",
    "tag": "lex-tok-tag",
    "url": "lex-tok-url",
    "variable": "lex-tok-variable",
  },
  quote: "lex-quote",
};

function onError(error: Error) {
  // Fall through to the LexicalErrorBoundary; surfacing here helps debug
  // unexpected node-replacement bugs without sinking the whole route.

  console.error("[lexical] internal error:", error);
}

function ToolbarButton({
  icon,
  title,
  onClick,
  active,
  disabled,
}: {
  readonly icon: JSX.Element;
  readonly title: string;
  readonly onClick: () => void;
  readonly active?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(active && "bg-accent text-accent-foreground")}
    >
      {icon}
    </Button>
  );
}

function Divider() {
  return <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />;
}

function Toolbar({ compact }: { readonly compact?: boolean | undefined }) {
  const { t } = useTranslation();
  const [editor] = useLexicalComposerContext();

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isStrike, setIsStrike] = useState(false);
  const [isInlineCode, setIsInlineCode] = useState(false);

  const refresh = useCallback(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      setIsBold(false);
      setIsItalic(false);
      setIsStrike(false);
      setIsInlineCode(false);
      return;
    }
    setIsBold(selection.hasFormat("bold"));
    setIsItalic(selection.hasFormat("italic"));
    setIsStrike(selection.hasFormat("strikethrough"));
    setIsInlineCode(selection.hasFormat("code"));
  }, []);

  useEffect(() => {
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(refresh);
      }),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          refresh();
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(CAN_UNDO_COMMAND, (payload) => {
        setCanUndo(payload);
        return false;
      }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(CAN_REDO_COMMAND, (payload) => {
        setCanRedo(payload);
        return false;
      }, COMMAND_PRIORITY_LOW),
    );
  }, [editor, refresh]);

  const setBlock = useCallback((create: () => ElementNode) => {
    editor.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel))
        $setBlocksType(sel, create);
    });
  }, [editor]);

  const insertHeading = useCallback((tag: "h1" | "h2" | "h3") => {
    setBlock(() => $createHeadingNode(tag));
  }, [setBlock]);

  const insertParagraph = useCallback(() => {
    setBlock(() => $createParagraphNode());
  }, [setBlock]);

  const insertQuote = useCallback(() => {
    setBlock(() => $createQuoteNode());
  }, [setBlock]);

  const insertCodeBlock = useCallback(() => {
    setBlock(() => $createCodeNode());
  }, [setBlock]);

  const insertLink = useCallback(() => {
    // window.prompt is the simplest cross-route prompt that doesn't require
    // a portal / extra state — keeping it small until a future link
    // floating-toolbar replaces this. eslint's no-alert flags it; suppress
    // with a comment so the gate still catches accidental new uses.
    // eslint-disable-next-line no-alert
    const url = window.prompt(t("editor.linkPrompt", "Enter URL"));
    if (url == null)
      return;
    if (url === "") {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
      return;
    }
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
  }, [editor, t]);

  const iconCls = "size-3.5";

  return (
    <div
      role="toolbar"
      aria-label={t("editor.toolbar", "Editor toolbar")}
      className="flex flex-wrap items-center gap-0.5 border-b bg-muted/30 px-2 py-1"
    >
      <ToolbarButton
        icon={<Undo2 className={iconCls} />}
        title={t("editor.undo", "Undo")}
        onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
        disabled={!canUndo}
      />
      <ToolbarButton
        icon={<Redo2 className={iconCls} />}
        title={t("editor.redo", "Redo")}
        onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
        disabled={!canRedo}
      />
      <Divider />
      {!compact && (
        <>
          <ToolbarButton icon={<Heading1 className={iconCls} />} title={t("editor.heading1", "Heading 1")} onClick={() => insertHeading("h1")} />
          <ToolbarButton icon={<Heading2 className={iconCls} />} title={t("editor.heading2", "Heading 2")} onClick={() => insertHeading("h2")} />
          <ToolbarButton icon={<Heading3 className={iconCls} />} title={t("editor.heading3", "Heading 3")} onClick={() => insertHeading("h3")} />
          <Divider />
        </>
      )}
      <ToolbarButton
        icon={<Bold className={iconCls} />}
        title={t("editor.bold")}
        active={isBold}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
      />
      <ToolbarButton
        icon={<Italic className={iconCls} />}
        title={t("editor.italic")}
        active={isItalic}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
      />
      {!compact && (
        <ToolbarButton
          icon={<Strikethrough className={iconCls} />}
          title={t("editor.strikethrough")}
          active={isStrike}
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough")}
        />
      )}
      <ToolbarButton
        icon={<Code className={iconCls} />}
        title={t("editor.inlineCode")}
        active={isInlineCode}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code")}
      />
      <ToolbarButton
        icon={<LinkIcon className={iconCls} />}
        title={t("editor.link")}
        onClick={insertLink}
      />
      {!compact && (
        <>
          <Divider />
          <ToolbarButton
            icon={<List className={iconCls} />}
            title={t("editor.bulletList")}
            onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}
          />
          <ToolbarButton
            icon={<ListOrdered className={iconCls} />}
            title={t("editor.orderedList")}
            onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}
          />
          <ToolbarButton
            icon={<ListChecks className={iconCls} />}
            title={t("editor.taskList")}
            onClick={() => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined)}
          />
          <Divider />
          <ToolbarButton icon={<Quote className={iconCls} />} title={t("editor.quote")} onClick={insertQuote} />
          <ToolbarButton icon={<Code2 className={iconCls} />} title={t("editor.codeBlock")} onClick={insertCodeBlock} />
        </>
      )}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        title={t("editor.paragraph", "Paragraph")}
        onClick={insertParagraph}
        className="ml-auto"
      >
        {t("editor.paragraph", "Paragraph")}
      </Button>
    </div>
  );
}

/**
 * Plugin: wire @lexical/code's registerCodeHighlighting so fenced code
 * blocks pick up Prism tokens. Languages must be imported up-top.
 */
function CodeHighlightPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerCodeHighlighting(editor), [editor]);
  return null;
}

/**
 * Synchronises external `value` (markdown) into the editor when it changes
 * out-of-band (e.g. server reload, form reset). Skips when the editor's
 * own serialized state already equals the incoming value to avoid loops.
 */
function ExternalValueSync({ value }: { readonly value: string }) {
  const [editor] = useLexicalComposerContext();
  const lastEmittedRef = useRef<string>(value);

  useEffect(() => {
    if (value === lastEmittedRef.current)
      return;
    lastEmittedRef.current = value;
    editor.update(() => {
      $convertFromMarkdownString(value, TRANSFORMERS);
    });
  }, [editor, value]);

  return null;
}

interface MarkdownChangeListenerProps {
  readonly onChange?: ((value: string) => void) | undefined;
  readonly lastEmittedRef: React.MutableRefObject<string>;
}

function MarkdownChangeListener({ onChange, lastEmittedRef }: MarkdownChangeListenerProps) {
  return (
    <OnChangePlugin
      onChange={(editorState) => {
        if (!onChange)
          return;
        editorState.read(() => {
          const md = $convertToMarkdownString(TRANSFORMERS);
          if (md === lastEmittedRef.current)
            return;
          lastEmittedRef.current = md;
          onChange(md);
        });
      }}
    />
  );
}

export function LexicalMarkdownEditor({
  value: controlledValue,
  defaultValue = "",
  onChange,
  compact = false,
  className,
  placeholder,
  minHeight,
}: LexicalMarkdownEditorProps) {
  const { t } = useTranslation();
  const initialValue = controlledValue ?? defaultValue;
  const lastEmittedRef = useRef<string>(initialValue);

  const initialConfig = {
    namespace: "app-md-editor",
    theme: editorTheme,
    onError,
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      CodeNode,
      CodeHighlightNode,
      LinkNode,
    ],
    editorState: () => $convertFromMarkdownString(initialValue, TRANSFORMERS),
  };

  const effectiveMinHeight = minHeight ?? (compact ? 80 : 280);

  return (
    <div className={cn("md-editor rounded-md border bg-background", className)}>
      <LexicalComposer initialConfig={initialConfig}>
        <Toolbar compact={compact} />
        <div className="md-editor-shell" style={{ minHeight: effectiveMinHeight }}>
          <RichTextPlugin
            contentEditable={(
              <ContentEditable
                className="md-editor-content outline-none"
                style={{ minHeight: effectiveMinHeight }}
                aria-placeholder={placeholder ?? ""}
                placeholder={
                  placeholder
                    ? <div className="md-editor-placeholder">{placeholder}</div>
                    : <div className="md-editor-placeholder">{t("editor.placeholder", "Start writing… Markdown shortcuts work as you type.")}</div>
                }
              />
            )}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <LinkPlugin />
        <TabIndentationPlugin />
        <CodeHighlightPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        {controlledValue !== undefined && <ExternalValueSync value={controlledValue} />}
        <MarkdownChangeListener onChange={onChange} lastEmittedRef={lastEmittedRef} />
      </LexicalComposer>
    </div>
  );
}

export default LexicalMarkdownEditor;
