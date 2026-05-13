/* eslint-disable react-refresh/only-export-components */
import { createFileRoute } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { Button } from "@/shared/components/ui/button";
import { APP_DISPLAY_NAME } from "@/shared/lib/branding";
import { BASE_PATH } from "@/shared/lib/http";

interface LoginSearchParams {
  redirect: string | undefined;
}

export const Route = createFileRoute("/login")({
  staticData: { titleKey: "login.title" },
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>): LoginSearchParams => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
});

function isSafeRedirect(url: string | undefined): string {
  if (!url)
    return `${BASE_PATH}/portal`;
  if (!url.startsWith("/") || url.startsWith("//"))
    return `${BASE_PATH}/portal`;
  return url;
}

function LoginPage() {
  const { t } = useTranslation();
  const { redirect } = Route.useSearch();

  const target = isSafeRedirect(redirect);
  const loginUrl = `${BASE_PATH}/api/account/auth/login?redirect=${encodeURIComponent(target)}`;

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
      <div className="mx-auto w-full max-w-xs text-center">
        <Logo className="mx-auto size-10 mb-3" />
        <h1 className="text-2xl font-bold tracking-tight">
          {APP_DISPLAY_NAME}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("login.description")}
        </p>

        <a href={loginUrl} className="mt-6 block">
          <Button className="w-full">
            <LogIn className="mr-2 size-4" />
            {t("login.button")}
          </Button>
        </a>
      </div>
    </div>
  );
}
