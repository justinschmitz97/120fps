import React from "react";
import { useTranslations } from "next-intl";

interface IntlWidgetProps {
  namespace: string;
}

export function IntlWidget({ namespace }: IntlWidgetProps) {
  const t = useTranslations(namespace);
  return <span>{t("title")}</span>;
}
