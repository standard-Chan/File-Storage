import { FileStore } from "tus-node-server";
import * as fs from "fs";
import * as path from "path";

type FileStoreOptions = ConstructorParameters<typeof FileStore>[0];

/**
 * FileStore를 확장한 CustomFileStore.
 * create 시, file.id에 디렉토리 구분자(/)가 포함된 경우
 * 해당 경로의 디렉토리가 없으면 재귀적으로 생성한다.
 */
class CustomFileStore extends FileStore {
  private readonly _directory: string;

  constructor(options: FileStoreOptions) {
    super(options);
    this._directory = options.directory;
  }

  create(
    file: Parameters<FileStore["create"]>[0]
  ): ReturnType<FileStore["create"]> {
    return new Promise((resolve, reject) => {
      const filePath = path.join(this._directory, (file as unknown as { id: string }).id);
      const dirPath = path.dirname(filePath);

      fs.mkdir(dirPath, { recursive: true }, (mkdirErr) => {
        if (mkdirErr) {
          return reject(mkdirErr);
        }

        return super.create(file).then(resolve).catch(reject);
      });
    });
  }
}

export default CustomFileStore;
