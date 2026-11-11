/** Observed request methods and encodings; request input cannot choose a destination. */
export const WEB_ROUTES = Object.freeze({
  translationLanguages: {
    path: "/v2/external/docTranslate/languages",
    method: "GET",
  },
  downloadFile: {
    path: "/v2/drive/downloadURL",
    method: "POST",
    encoding: "json",
  },
  points: {
    path: "/v2/vipcenter/aitoken/get-v2",
    method: "POST",
    encoding: "json",
  },
  pointsPreference: {
    path: "/v2/vipcenter/aitoken/points/preference/get",
    method: "POST",
    encoding: "json",
  },
  rights: {
    path: "/v2/vipcenter/rights/get",
    method: "POST",
    encoding: "json",
  },
  voiceRight: { path: "/v2/vipcenter/right/get", method: "GET" },
  pdfConvert: {
    path: "/v2/drive/pdf2office/convert",
    method: "POST",
    encoding: "json",
  },
  pdfProgress: {
    path: "/v2/drive/pdf2office/query",
    method: "POST",
    encoding: "json",
  },
  pdfSave: {
    path: "/v2/drive/pdf2office/save",
    method: "POST",
    encoding: "json",
  },
  compressSubmit: {
    path: "/api/drive/compressfile/submit",
    method: "POST",
    encoding: "json",
  },
  compressProgress: {
    path: "/api/drive/compressfile/progress",
    method: "POST",
    encoding: "json",
  },
  importSecret: {
    path: "/v1/import/secretKey",
    method: "POST",
    encoding: "json",
  },
  importFile: {
    path: "/v1/import/file",
    method: "POST",
    encoding: "multipart",
  },
  importThird: {
    path: "/v1/import/third",
    method: "POST",
    encoding: "multipart",
  },
  importProgress: { path: "/v1/import/queryImportProgress", method: "GET" },
  uploadImage: {
    path: "/v1/image/upload",
    method: "POST",
    encoding: "multipart",
  },
  officePdfSubmit: {
    path: "/v1/export/office2pdf/online",
    method: "POST",
    encoding: "multipart",
  },
  officePdfProgress: {
    path: "/v1/export/office2pdf/online/progress",
    method: "GET",
  },
  onlineConvert: {
    path: "/api/v1/convert/online2online",
    method: "POST",
    encoding: "multipart",
  },
  onlineProgress: {
    path: "/api/v1/convert/online2online/progress",
    method: "GET",
  },
  createPath: { path: "/api/create/path", method: "POST", encoding: "json" },
  createContent: {
    path: "/api/create/file/with/content",
    method: "POST",
    encoding: "json",
  },
  sheetSubIds: {
    path: "/api/form/read/sheet/subid",
    method: "POST",
    encoding: "json",
  },
  sheetData: {
    path: "/api/form/read/sheet/data",
    method: "POST",
    encoding: "json",
  },
  createForm: {
    path: "/api/form/write/create_form",
    method: "POST",
    encoding: "json",
  },
  resumeImport: {
    path: "/api/resume/import/files",
    method: "POST",
    encoding: "json",
  },
  personalSpace: {
    path: "/api/space/query/personal",
    method: "POST",
    encoding: "json",
  },
  createDocument: {
    path: "/cgi-bin/online_docs/createdoc_new",
    method: "POST",
    encoding: "multipart",
  },
  clipPage: { path: "/api/smartdoc/urltosc", method: "POST", encoding: "json" },
  clipProgress: {
    path: "/api/smartdoc/get/import/progress",
    method: "POST",
    encoding: "json",
  },
});
