export interface CardProps {
  title: string;
  compact?: boolean;
}

export function Card({ title, compact = false }: CardProps) {
  return (
    <div className={compact ? "card p-2" : "card p-4"}>
      <button type="button" className="text-brand">
        {title}
      </button>
    </div>
  );
}
