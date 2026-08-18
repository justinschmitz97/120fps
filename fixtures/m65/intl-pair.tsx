import React from "react";
import { useTranslations } from "next-intl";
import { IntlLabel } from "./intl-helper.js";

export function IntlPair({ id }: { id: string }) {
  const t = useTranslations("pair");
  return (
    <div>
      {t("title")}
      <IntlLabel id={id} />
    </div>
  );
}
