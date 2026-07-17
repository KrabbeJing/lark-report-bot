export class SerialTaskQueue {
  constructor() {
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  enqueue(task) {
    this.pending += 1;
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => {}).finally(() => {
      this.pending -= 1;
    });
    return run;
  }
}
