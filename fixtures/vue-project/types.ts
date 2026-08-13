export interface CardItem {
  id: number;
  title: string;
}

export interface CardProps {
  heading: string;
  items: CardItem[];
  compact?: boolean;
  tone?: "neutral" | "warning";
}
