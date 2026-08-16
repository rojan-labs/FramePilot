/** A labelled select row that shares the inspector's alignment and density rules. */
import { Select } from '../Select.js';
import { InspectorRow } from './InspectorRow.js';

export function LabeledSelect<T extends string>({
  caption,
  label,
  value,
  options,
  labels,
  onChange,
}: {
  readonly caption: string;
  readonly label: string;
  readonly value: T;
  readonly options: readonly T[];
  /** Display text per option when the stored value is not user-facing copy. */
  readonly labels?: readonly string[];
  readonly onChange: (value: T) => void;
}): JSX.Element {
  return (
    <InspectorRow label={caption} name={label}>
      <Select
        label={label}
        value={value}
        onChange={onChange}
        options={options.map((option, index) => ({
          value: option,
          label: labels?.[index] ?? option,
        }))}
      />
    </InspectorRow>
  );
}
