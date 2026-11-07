import React from "react";
import { Button, Callout, Intent } from "@blueprintjs/core";

export interface IUnappliedChangesProps {
  canApply: boolean;
  onApply(): void;
  onDiscard(): void;
}

/** Warns that the edited values are not used yet by the preview, the piano and the DXF. */
export function UnappliedChanges(props: IUnappliedChangesProps) {
  return (
    <Callout intent={Intent.WARNING} title="Changes not applied yet" className="mb-unappliedChanges">
      <p>The preview, the piano and the downloaded DXF still use the previous values.</p>
      <Button intent={Intent.PRIMARY} disabled={!props.canApply} onClick={props.onApply}>
        Apply
      </Button>{" "}
      <Button onClick={props.onDiscard}>Discard</Button>
    </Callout>
  );
}
