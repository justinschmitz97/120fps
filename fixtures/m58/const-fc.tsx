import React from "react";

interface StripeProps {
  offset: number;
}

const Stripe = ({ offset }: StripeProps) => <hr data-offset={offset} />;

interface BannerProps {
  headline: string;
  dismissible?: boolean;
}

export const Banner: React.FC<BannerProps> = ({ headline, dismissible = false }) => (
  <div>
    <Stripe offset={0} />
    {headline}
    {dismissible && <button type="button">x</button>}
  </div>
);
