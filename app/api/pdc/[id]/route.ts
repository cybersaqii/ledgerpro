// NOTE: PDC lifecycle actions (clear / bounce / cancel) live at
// app/api/pdc/[id]/[action]/route.ts — POST /api/pdc/{id}/clear etc.
// The action-dispatch POST that used to live here is gone: it matched
// /api/pdc/{id} only, so its pathname-based dispatch could never fire and
// the UI's /api/pdc/{id}/clear calls 404'd. This file intentionally exports
// no handlers.
export {};
