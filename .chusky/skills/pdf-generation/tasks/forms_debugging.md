# Debug PDF forms

When a form looks empty after filling:
- confirm the field value exists in the PDF object;
- inspect `/NeedAppearances`;
- check widget annotations;
- confirm appearance streams;
- render with more than one viewer when possible.

When fields cannot be found, inspect the full field tree because child widgets may have inherited names or values.

Do not assume a viewer bug until the PDF field structure is checked.
