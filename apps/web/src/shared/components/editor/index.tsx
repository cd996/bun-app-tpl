// Public entry for the project's markdown surface.
//
// `readOnly` paths render via `markdown-preview` (react-markdown + Shiki —
// lightweight, no contenteditable footprint); editable paths mount the
// Milkdown-based WYSIWYG editor that round-trips markdown via its built-in
// remark serialiser. Both are React.lazy so the route-shell stays small
// for users that never open one.
//
// External shape is unchanged from earlier editor revisions; callers in
// documents / todos do not need to migrate.

import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";

const LazyMarkdownPreview = lazy(() => import("./markdown-preview"));
const LazyMilkdownEditor = lazy(() => import("./milkdown-editor"));

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
  // Drop `readOnly` from the editor props — the WYSIWYG mode is always
  // editable. Forward the rest 1:1.
  const editorProps: ComponentProps<typeof LazyMilkdownEditor> = {
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
      <LazyMilkdownEditor {...editorProps} />
    </Suspense>
  );
}
