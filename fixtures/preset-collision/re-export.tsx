// M112 (radix-themes-F1): `button.props.tsx` next to `button.tsx` is real
// component source that re-exports a named binding, not a preset.
export interface ReExportProps {
  variant?: "solid" | "soft";
  size?: "1" | "2";
  p1?: string;
  p2?: string;
  p3?: string;
  p4?: string;
  p5?: string;
  p6?: string;
  p7?: string;
  p8?: string;
  p9?: string;
  p10?: string;
  p11?: string;
  p12?: string;
  p13?: string;
  p14?: string;
  p15?: string;
  p16?: string;
  p17?: string;
  p18?: string;
  p19?: string;
  p20?: string;
  p21?: string;
  p22?: string;
  p23?: string;
  p24?: string;
  p25?: string;
  p26?: string;
  p27?: string;
  p28?: string;
  p29?: string;
  p30?: string;
  p31?: string;
  p32?: string;
  p33?: string;
  p34?: string;
  p35?: string;
  p36?: string;
  p37?: string;
  p38?: string;
  p39?: string;
  p40?: string;
}

export function ReExport(props: ReExportProps) {
  return <div data-variant={props.variant}>{props.p1}</div>;
}
