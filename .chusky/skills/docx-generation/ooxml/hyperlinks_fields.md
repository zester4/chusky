# OOXML: hyperlinks and fields

External hyperlinks generally require a relationship and `<w:hyperlink r:id=...>`.

Internal hyperlinks can use `w:anchor` with a bookmark target.

Complex fields commonly use `fldChar` begin/separate/end plus `instrText`. Simple fields may use `<w:fldSimple>`.

Fields can have stale cached display text. Do not assume a headless renderer will update them.
