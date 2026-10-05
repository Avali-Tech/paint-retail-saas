import { Field, Input } from '@paint/ui';

/** Rows per page of the CRM lists. */
export const PAGE_SIZE = 50;
/** How long typing pauses before a list searches. */
export const SEARCH_DELAY_MS = 300;

/** The search box of a list: what is typed goes in the address; the list follows once typing stops. */
export function SearchFilter({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="filters__search">
      <Field label={label}>
        <Input
          type="search"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </Field>
    </div>
  );
}
