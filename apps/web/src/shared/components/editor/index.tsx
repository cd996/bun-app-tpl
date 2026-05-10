// Public entry for the project's markdown surface.
//
// `readOnly` paths render via `markdown-preview` (react-markdown + Shiki —
// lightweight, no contenteditable footprint); editable paths mount the
// Lexical-based WYSIWYG editor that round-trips through the markdown
// transformers from `@lexical/markdown`. Both are React.lazy so the
// route-shell stays small for users that never open one.
//
// External shape is unchanged from the previous textarea-based editor;
// callers in documents / todos do not need to migrate.

import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";

const LazyMarkdownPreview = lazy(() => import("./markdown-preview"));
const LazyLexicalEditor = lazy(() => import("./lexical-editor"));

interface MarkdownEditorProps {
  readonly value?: string | undefined;
  readonly defaultValue?: string | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly readOnly?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly minHeight?: number | undefined;
}

function Fallback() {
  return <div className="text-sm text-muted-foreground">Loading editor…</div>;
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  if (props.readOnly) {
    return (
      <Suspense fallback={<Fallback />}>
        <LazyMarkdownPreview value={props.value ?? props.defaultValue ?? ""} className={props.className} />
      </Suspense>
    );
  }
  // Drop `readOnly` from the editor props — Lexical mode is always editable.
  // Forward the rest 1:1.
  const editorProps: ComponentProps<typeof LazyLexicalEditor> = {
    value: props.value,
    defaultValue: props.defaultValue,
    onChange: props.onChange,
    compact: props.compact,
    className: props.className,
    placeholder: props.placeholder,
    minHeight: props.minHeight,
  };
  return (
    <Suspense fallback={<Fallback />}>
      <LazyLexicalEditor {...editorProps} />
    </Suspense>
  );
}
