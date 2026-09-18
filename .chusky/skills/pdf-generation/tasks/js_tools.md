# JavaScript PDF tools

Use `pdf-lib` for object-level creation/editing when Node is the better environment. Use PDF.js for reading/rendering/inspection.

Guidelines:
- keep binary data as bytes/base64, not accidental UTF-8 strings;
- preserve page boxes and rotation;
- embed fonts deliberately;
- inspect form appearance behavior;
- render after mutation;
- avoid hand-writing PDF syntax.

For complex report layout, Chusky's native PDF creator or a document-to-PDF pipeline is usually safer than low-level PDF construction.
