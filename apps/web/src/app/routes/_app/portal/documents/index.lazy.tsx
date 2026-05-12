/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

export const Route = createLazyFileRoute("/_app/portal/documents/")({
  component: DocumentsEmptyPage,
});

function DocumentsEmptyPage() {
  const { t } = useTranslation("documents");
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <div className="text-center">
        <FileText className="mx-auto mb-3 size-10 opacity-30" />
        <p className="text-sm">{t("selectToView")}</p>
      </div>
    </div>
  );
}
