---
id: generic-form
title: Generic Form Filling
summary: Resolve fields by stable identity first and verify typed/select state on the actual form control.
hosts:
keywords: form, input, textbox, textarea, select, dropdown, submit, field
---
# Generic Form Filling

- Prefer aria snapshot refs when available.
- For semantic fallback targets, prioritize in this order: `id`, `aria-label`, `name`, associated `<label>`, `placeholder`, `role+name`.
- For text entry, focus the exact control before inserting text.
- For selects, act on the real `<select>` element or combobox control, not a decorative wrapper.
- After every fill/select step, verify the control value or selected option text before continuing.
- If the field is ambiguous, take a fresh snapshot or structured extract instead of guessing.

