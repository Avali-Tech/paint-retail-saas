// English messages for documents attached to records (spread into en.ts).

export const documentsEn = {
  documents: {
    title: 'Documents',
    error: 'Could not load the documents',
    empty: 'No documents yet',
    upload: 'Upload',
    uploadTitle: 'Upload a document',
    uploadHint: 'PDF, photo (JPG, PNG, WebP or HEIC), Word or Excel; up to 10 MB.',
    file: 'File',
    category: 'What it is',
    note: 'Note',
    noteHint: 'Optional, e.g. “North wall before repair”',
    save: 'Upload',
    uploaded: 'Document uploaded',
    download: 'Download {name}',
    downloadButton: 'Download',
    downloadFailed: 'Could not download the file',
    remove: 'Delete',
    removeName: 'Delete {name}',
    removeTitle: 'Delete {name}?',
    removeDescription: 'It disappears from this record. The file is kept for the audit trail.',
    removed: 'Document deleted',
    meta: '{category} · {size} · {name} · {date}',
    sizeBytes: '{size} B',
    sizeKb: '{size} KB',
    sizeMb: '{size} MB',
    problems: {
      noFile: 'Choose a file to upload',
      empty: 'This file is empty',
      tooBig:
        'This file is larger than 10 MB. Make it smaller (for example, scan at a lower resolution) and try again.',
      type: 'This kind of file is not accepted. Upload a PDF, a photo (JPG, PNG, WebP or HEIC), or a Word or Excel file.',
      scannerOff:
        'The virus scanner is off or not working, so the file was not saved. Try again later, or ask your administrator to turn virus scanning on.',
      storageOff: 'Document storage is not set up on this server, so the file was not saved.',
      infected: 'The file was refused: {detail}',
    },
  },
};
