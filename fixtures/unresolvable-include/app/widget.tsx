import { root } from "#app/root";
import clsx from "clsx";
import ts from "typescript";

export const Widget = () => clsx(root, ts.version);
