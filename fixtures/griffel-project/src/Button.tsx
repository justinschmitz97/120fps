import { makeStyles } from "@griffel/react";

const useStyles = makeStyles({ root: { display: "inline-flex" } });

export function Button(props: { label?: string }) {
  const styles = useStyles();
  return <button className={styles.root}>{props.label ?? "Go"}</button>;
}
