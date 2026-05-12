// Milkdown-based markdown editor.
//
// Storage stays markdown (the DB column is `TEXT` markdown — see
// docs/operations.md and the FTS5 index). Milkdown is built on
// ProseMirror + remark; the editor's serialiser owns markdown I/O, so
// we just feed it a string via `defaultValueCtx` and subscribe to
// `listenerCtx.markdownUpdated` to get the next markdown back.
//
// Markdown shortcuts (`# ` → h1, `**foo**` → bold, ``` ``` → code block,
// `[ ] ` → task list) work as you type because they are wired into the
// commonmark / gfm presets via ProseMirror input rules.

import type { Ctx } from "@milkdown/kit/ctx";
import type { JSX } from "react";

import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { history, redoCommand, undoCommand } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import {
  commonmark,
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { gfm, insertTableCommand, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { lift } from "@milkdown/kit/prose/commands";
import { callCommand, replaceAll } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import {
  Bold,
  CheckSquare,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/lib/utils";

import "./milkdown-editor.css";

interface MilkdownMarkdownEditorProps {
  readonly value?: string | undefined;
  readonly defaultValue?: string | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly minHeight?: number | undefined;
}

function ToolbarButton({
  icon,
  title,
  onClick,
  disabled,
}: {
  readonly icon: JSX.Element;
  readonly title: string;
  readonly onClick: () => void;
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
    >
      {icon}
    </Button>
  );
}

function Divider() {
  return <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />;
}

// Toggle blockquote on the current selection.
//
// `wrapInBlockquoteCommand` from milkdown is built on ProseMirror's `wrapIn`,
// which always adds a new wrapper without checking whether the selection is
// already inside a blockquote — clicking twice stacks `> > foo`. We invert
// that: if the selection sits anywhere inside a blockquote, `lift` removes
// the wrapper; otherwise we fall through to the wrap command.
function toggleBlockquote(ctx: Ctx) {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "blockquote") {
      lift(state, view.dispatch);
      return;
    }
  }
  callCommand(wrapInBlockquoteCommand.key)(ctx);
}

// Toggle a task-list item on the current selection.
//
// Milkdown's GFM preset ships an *input rule* for `[ ] ` / `[x] ` but no
// imperative command — task-list state lives as a `checked` attr on the
// `list_item` node. So we walk up the selection looking for a list_item;
// if found, flip `checked` between `null` (plain list) and `false` (task);
// otherwise we first wrap the block into a bullet list, then toggle. Two
// transactions are fine here — callCommand dispatches synchronously, so the
// new list_item is already in `view.state` by the time we re-read it.
function toggleTaskList(ctx: Ctx) {
  const flipAtDepth = () => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const { $from } = state.selection;
    let depth = -1;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "list_item") {
        depth = d;
        break;
      }
    }
    if (depth < 0)
      return false;
    const node = $from.node(depth);
    const pos = $from.before(depth);
    const nextChecked = node.attrs.checked == null ? false : null;
    view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: nextChecked }));
    return true;
  };
  if (flipAtDepth())
    return;
  callCommand(wrapInBulletListCommand.key)(ctx);
  flipAtDepth();
}

function Toolbar({ compact }: { readonly compact?: boolean | undefined }) {
  const { t } = useTranslation();
  const [loading, getInstance] = useInstance();

  // Wrap callCommand so the button handlers stay one-liners and gracefully
  // no-op while the editor is still mounting.
  const run = (fn: (ctx: Ctx) => void) => {
    if (loading)
      return;
    const editor = getInstance();
    if (!editor)
      return;
    editor.action(fn);
  };

  const promptLink = () => {
    // window.prompt is the simplest cross-route prompt that doesn't require
    // a portal / extra state — keeping it small until a future link
    // floating-toolbar replaces this. eslint's no-alert flags it; suppress
    // with a comment so the gate still catches accidental new uses.
    // eslint-disable-next-line no-alert
    const url = window.prompt(t("editor.linkPrompt", "Enter URL"));
    if (url == null)
      return;
    run(callCommand(toggleLinkCommand.key, { href: url, title: "" }));
  };

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
        onClick={() => run(callCommand(undoCommand.key))}
      />
      <ToolbarButton
        icon={<Redo2 className={iconCls} />}
        title={t("editor.redo", "Redo")}
        onClick={() => run(callCommand(redoCommand.key))}
      />
      {!compact && (
        <>
          <Divider />
          <ToolbarButton icon={<Heading1 className={iconCls} />} title={t("editor.heading1", "Heading 1")} onClick={() => run(callCommand(wrapInHeadingCommand.key, 1))} />
          <ToolbarButton icon={<Heading2 className={iconCls} />} title={t("editor.heading2", "Heading 2")} onClick={() => run(callCommand(wrapInHeadingCommand.key, 2))} />
          <ToolbarButton icon={<Heading3 className={iconCls} />} title={t("editor.heading3", "Heading 3")} onClick={() => run(callCommand(wrapInHeadingCommand.key, 3))} />
        </>
      )}
      <Divider />
      <ToolbarButton
        icon={<Bold className={iconCls} />}
        title={t("editor.bold")}
        onClick={() => run(callCommand(toggleStrongCommand.key))}
      />
      <ToolbarButton
        icon={<Italic className={iconCls} />}
        title={t("editor.italic")}
        onClick={() => run(callCommand(toggleEmphasisCommand.key))}
      />
      {!compact && (
        <ToolbarButton
          icon={<Strikethrough className={iconCls} />}
          title={t("editor.strikethrough")}
          onClick={() => run(callCommand(toggleStrikethroughCommand.key))}
        />
      )}
      <ToolbarButton
        icon={<Code className={iconCls} />}
        title={t("editor.inlineCode")}
        onClick={() => run(callCommand(toggleInlineCodeCommand.key))}
      />
      <ToolbarButton
        icon={<LinkIcon className={iconCls} />}
        title={t("editor.link")}
        onClick={promptLink}
      />
      <Divider />
      <ToolbarButton
        icon={<List className={iconCls} />}
        title={t("editor.bulletList")}
        onClick={() => run(callCommand(wrapInBulletListCommand.key))}
      />
      <ToolbarButton
        icon={<ListOrdered className={iconCls} />}
        title={t("editor.orderedList")}
        onClick={() => run(callCommand(wrapInOrderedListCommand.key))}
      />
      {!compact && (
        <ToolbarButton
          icon={<CheckSquare className={iconCls} />}
          title={t("editor.taskList")}
          onClick={() => run(toggleTaskList)}
        />
      )}
      {!compact && (
        <>
          <Divider />
          <ToolbarButton
            icon={<Quote className={iconCls} />}
            title={t("editor.quote")}
            onClick={() => run(toggleBlockquote)}
          />
          <ToolbarButton
            icon={<Code2 className={iconCls} />}
            title={t("editor.codeBlock")}
            onClick={() => run(callCommand(createCodeBlockCommand.key))}
          />
          <Divider />
          <ToolbarButton
            icon={<TableIcon className={iconCls} />}
            title={t("editor.table")}
            onClick={() => run(callCommand(insertTableCommand.key))}
          />
          <ToolbarButton
            icon={<Minus className={iconCls} />}
            title={t("editor.horizontalRule")}
            onClick={() => run(callCommand(insertHrCommand.key))}
          />
        </>
      )}
    </div>
  );
}

// Tracks emptiness for the placeholder overlay. Milkdown's listener fires
// `markdownUpdated` on every doc change so a single boolean is enough — we
// only care whether the serialised value collapses to "".
function EmptyTracker({ initial, setIsEmpty }: { readonly initial: string; readonly setIsEmpty: (v: boolean) => void }) {
  const [loading, getInstance] = useInstance();

  useEffect(() => {
    if (loading)
      return;
    const editor = getInstance();
    if (!editor)
      return;
    editor.action((ctx) => {
      ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
        setIsEmpty(md.trim() === "");
      });
    });
  }, [loading, getInstance, setIsEmpty]);

  // Seed the initial flag without waiting for the first listener tick.
  useEffect(() => {
    setIsEmpty(initial.trim() === "");
  }, [initial, setIsEmpty]);

  return null;
}

// Reflects external `value` changes back into the editor. The lastEmittedRef
// guard prevents the round-trip "I emitted X, parent set X back" from
// triggering a redundant `replaceAll` that would steal the user's cursor.
function ExternalValueSync({
  value,
  lastEmittedRef,
}: {
  readonly value: string;
  readonly lastEmittedRef: React.MutableRefObject<string>;
}) {
  const [loading, getInstance] = useInstance();

  useEffect(() => {
    if (loading)
      return;
    if (value === lastEmittedRef.current)
      return;
    const editor = getInstance();
    if (!editor)
      return;
    lastEmittedRef.current = value;
    editor.action(replaceAll(value));
  }, [loading, getInstance, value, lastEmittedRef]);

  return null;
}

interface EditorBodyProps extends MilkdownMarkdownEditorProps {
  readonly initialValue: string;
  readonly lastEmittedRef: React.MutableRefObject<string>;
}

function EditorBody({
  initialValue,
  lastEmittedRef,
  value: controlledValue,
  onChange,
  compact = false,
  placeholder,
  minHeight,
}: EditorBodyProps) {
  const { t } = useTranslation();
  const [isEmpty, setIsEmpty] = useState(initialValue.trim() === "");

  // Pin onChange in a ref so the editor factory (which runs once) always
  // sees the latest callback without re-creating the editor on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEditor(root =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialValue);
        ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
          if (md === lastEmittedRef.current)
            return;
          lastEmittedRef.current = md;
          onChangeRef.current?.(md);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener));

  const effectiveMinHeight = minHeight ?? (compact ? 80 : 280);
  const placeholderText = placeholder ?? t("editor.placeholder", "Start writing… Markdown shortcuts work as you type.");

  return (
    <>
      <Toolbar compact={compact} />
      <div className="md-editor-shell" style={{ minHeight: effectiveMinHeight }}>
        <Milkdown />
        {isEmpty && <div className="md-editor-placeholder">{placeholderText}</div>}
      </div>
      <EmptyTracker initial={initialValue} setIsEmpty={setIsEmpty} />
      {controlledValue !== undefined && <ExternalValueSync value={controlledValue} lastEmittedRef={lastEmittedRef} />}
    </>
  );
}

export function MilkdownMarkdownEditor(props: MilkdownMarkdownEditorProps) {
  const initialValue = props.value ?? props.defaultValue ?? "";
  // Stable across re-renders: the editor seeds itself from `initialValue`
  // exactly once via `defaultValueCtx`; subsequent external updates are
  // handled by `ExternalValueSync`.
  const lastEmittedRef = useRef<string>(initialValue);

  return (
    <div className={cn("md-editor rounded-md border bg-background", props.className)}>
      <MilkdownProvider>
        <EditorBody {...props} initialValue={initialValue} lastEmittedRef={lastEmittedRef} />
      </MilkdownProvider>
    </div>
  );
}

export default MilkdownMarkdownEditor;
