import { UploadJob } from "./types";

export class PriorityQueue {
  private readonly items: UploadJob[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  enqueue(job: UploadJob): void {
    if (!job) {
      throw new Error("job 값이 존재하지 않아 추가할 수 없습니다.");
    }
    if (this.isFull()) {
      throw new Error(`큐가 가득 찼습니다: max=${this.maxSize}`);
    }

    this.items.push(job);
    this.bubbleUp(this.items.length - 1);
  }

  dequeue(): UploadJob | undefined {
    if (this.isEmpty()) return undefined;

    const first = this.items[0];
    const last = this.items.pop();

    if (last && this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }

    return first;
  }

  peek(): UploadJob | undefined {
    return this.items[0];
  }

  size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  isFull(): boolean {
    return this.items.length >= this.maxSize;
  }

  snapshot(): UploadJob[] {
    return [...this.items];
  }

  removeByJobId(jobId: string): UploadJob | undefined {
    const index = this.items.findIndex((job) => job.jobId === jobId);
    if (index < 0) {
      return undefined;
    }

    const removed = this.items[index];
    const last = this.items.pop();

    if (last && index < this.items.length) {
      this.items[index] = last;
      this.bubbleUp(index);
      this.bubbleDown(index);
    }

    return removed;
  }

  /**
   * 힙(Heap) 전체를 다시 정렬하여 힙을 복구하는 메서드
   */
  reheapify(): void {
    if (this.items.length <= 1) {
      return;
    }

    for (let i = Math.floor((this.items.length - 2) / 2); i >= 0; i -= 1) {
      this.bubbleDown(i);
    }
  }

  // TODO : job과 너무 강하게 묶여있다. 범용성 있는 priority queue를 별도로 만들자.
  private compare(jobA: UploadJob, jobB: UploadJob): number {
    if (jobA.score !== jobB.score) {
      return jobB.score - jobA.score;
    }

    if (jobA.enqueuedAt !== jobB.enqueuedAt) {
      return jobA.enqueuedAt - jobB.enqueuedAt;
    }

    return jobA.fileSize - jobB.fileSize;
  }

  /**
   * 힙(Heap)에서 삽입 후 정렬을 유지하기 위한 bubble-up(상향 이동) 메서드
   * @param index - 새로 삽입된 요소의 초기 위치 (배열의 마지막 index)
   */
  private bubbleUp(index: number): void {
    let cursor = index;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.compare(this.items[parent], this.items[cursor]) <= 0) {
        break;
      }

      [this.items[parent], this.items[cursor]] = [this.items[cursor], this.items[parent]];
      cursor = parent;
    }
  }

  /**
   * 힙(Heap)에서 삭제 후 정렬을 유지하기 위한 bubble-down(하향 이동) 메서드
   * @param index 재정렬을 시작할 위치
   */
  private bubbleDown(index: number): void {
    let cursor = index;
    const size = this.items.length;

    while (true) {
      const left = cursor * 2 + 1;
      const right = cursor * 2 + 2;
      let candidate = cursor;

      if (left < size && this.compare(this.items[left], this.items[candidate]) < 0) {
        candidate = left;
      }
      if (right < size && this.compare(this.items[right], this.items[candidate]) < 0) {
        candidate = right;
      }

      if (candidate === cursor) {
        break;
      }

      [this.items[cursor], this.items[candidate]] = [this.items[candidate], this.items[cursor]];
      cursor = candidate;
    }
  }
}