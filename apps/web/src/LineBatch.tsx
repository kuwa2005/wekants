import type { TitleBatch } from "@wekants/shared";

type Props = {
  name: string;
  value: TitleBatch;
  onChange: (value: TitleBatch) => void;
  oneLabel: string;
  manyLabel: string;
};

export function LineBatch({ name, value, onChange, oneLabel, manyLabel }: Props) {
  return (
    <fieldset className="many-lines">
      <legend>行の扱い</legend>
      <label>
        <input
          type="radio"
          name={name}
          checked={value === "one"}
          onChange={() => onChange("one")}
        />
        {oneLabel}
      </label>
      <label>
        <input
          type="radio"
          name={name}
          checked={value === "many"}
          onChange={() => onChange("many")}
        />
        {manyLabel}
      </label>
    </fieldset>
  );
}
