import React from "react";
import type { Messages } from "next-intl";

interface TypeOnlyIntlProps {
  messages: Messages;
}

export function TypeOnlyIntl({ messages }: TypeOnlyIntlProps) {
  return <span>{String(messages)}</span>;
}
