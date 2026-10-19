import { Hint } from "@/components/Hint";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxGroup } from "@/components/ui/checkbox-group";
import { Label } from "@/components/ui/label";
import { MODES, MODE_HINT, MODE_WORD } from "@/lib/api";

/** The two permissions, as checkboxes. */
export function PermissionBoxes({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <CheckboxGroup value={value} onValueChange={onChange} className="flex-row gap-5">
      <Label className="flex items-center gap-2 font-normal">
        <Checkbox value="1" /> <Hint text="supportsApprovalMode(0x1): APPROVE_PAYMENT">Pay gas</Hint>
      </Label>
      <Label className="flex items-center gap-2 font-normal">
        <Checkbox value="2" /> <Hint text="supportsApprovalMode(0x2): APPROVE_EXECUTION">Execute calls</Hint>
      </Label>
    </CheckboxGroup>
  );
}

export function ShapeBoxes({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <CheckboxGroup value={value} onValueChange={onChange} className="flex-row flex-wrap gap-5">
      {MODES.map((m) => (
        <Label key={m} className="flex items-center gap-2 font-normal">
          <Checkbox value={m} /> <Hint text={MODE_HINT[m]}>{MODE_WORD[m]}</Hint>
        </Label>
      ))}
    </CheckboxGroup>
  );
}
