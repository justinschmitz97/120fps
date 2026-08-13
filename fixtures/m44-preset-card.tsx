export interface Row {
  id: string;
  label: string;
}

export function PresetCard({
  title,
  rows = [],
  onSelect,
}: {
  title: string;
  rows?: Row[];
  onSelect?: (id: string) => void;
}) {
  return (
    <section data-testid="card">
      <h2>{title}</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.id} onClick={() => onSelect?.(r.id)}>
            {r.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default PresetCard;
