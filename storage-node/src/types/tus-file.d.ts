declare module 'tus-node-server/lib/models/File' {
  class File {
    constructor(
      file_id: string,
      upload_length: string,
      upload_defer_length: string,
      upload_metadata: string
    );
    id: string;
    upload_length: string;
    upload_defer_length: string;
    upload_metadata: string;
  }
  export = File;
}