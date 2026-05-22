const fs = require("node:fs");
const path = require("node:path");

class JsonStore {
  constructor(filePath, initialValue) {
    this.filePath = filePath;
    this.initialValue = initialValue;
    this.value = this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return structuredClone(this.initialValue);
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return structuredClone(this.initialValue);
    }
  }

  get() {
    return this.value;
  }

  set(nextValue) {
    this.value = nextValue;
    this.save();
  }

  update(mutator) {
    const draft = structuredClone(this.value);
    const result = mutator(draft);
    this.value = result === undefined ? draft : result;
    this.save();
    return this.value;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.value, null, 2));
  }
}

module.exports = { JsonStore };
