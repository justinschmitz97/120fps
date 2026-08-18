import React from "react";
import { useTranslations } from "next-intl";

export function IntlLabel({ id }: { id: string }) {
  const t = useTranslations("labels");
  return <em>{t(id)}</em>;
}
