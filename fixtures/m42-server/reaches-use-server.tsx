import { submit } from "./lib/action";

export function ReachesUseServer() {
  return <button onClick={() => void submit()}>send</button>;
}
