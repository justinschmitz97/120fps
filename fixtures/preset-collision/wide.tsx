// M112: a component whose prop count trips the cap, next to a real preset
// under the preferred name. The cap remedy must name that file.
export interface WideProps {
  variant?: "solid" | "soft";
  size?: "1" | "2";
  // A union the extraction actually collapses (a string literal beside an
  // object), so the preset below has a remedy to answer.
  tone?: "solid" | { level: number };
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

export function Wide(props: WideProps) {
  return <div data-variant={props.variant}>{props.p1}</div>;
}
