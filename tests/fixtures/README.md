# Offline host contract fixture

`counter-host.json` is a sanitized host inventory for `fixtures/gm-projects/counter`, captured from the GM2Godot host snapshot producer. Paths are project-relative. Its API support entries are restricted to calls present in the fixture. It is recorded test data, not a live claim about installed converter support.

Ordinary tests use this record and hash the actual fixture files; they need neither Python nor a GM2Godot checkout. To refresh against a checkout, set `DEEP_INTEGRATION=1`, `GM2GODOT_CHECKOUT`, and `GM2GODOT_PYTHON`. Engine-backed integration/e2e tests additionally require `GODOT_BIN`. A successful offline test does not prove real provider access or engine behavior.
