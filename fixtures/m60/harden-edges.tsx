import React from "react";
import type { AddressInfo } from "node:net";

interface Base {
  alpha: string;
  omit: number;
}

type Picked = Omit<Base, "omit"> & { beta: boolean };

interface Row {
  id: number;
}

interface Listing<T = Row> {
  rows: T[];
}

enum Level {
  Low = 1,
  High = 2,
}

interface EdgeProps extends AddressInfo {
  picked: Picked;
  listing: Listing;
  level: Level;
  stamps: Date[];
  buckets: Map<string, number>[];
  frozenPair: readonly [string, string];
  nullable: Base | null;
  loose: unknown;
}

export function EdgeCases(props: EdgeProps) {
  return <div data-port={props.port}>{props.picked.alpha}</div>;
}
