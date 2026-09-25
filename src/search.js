const createLongHeap = (capacity) => {
    // Using Float64Array for 64-bit precision without BigInt conversion overhead
    const data = new Float64Array(capacity * 3);
    let size = 0;

    const swap = (i, j) => {
        for (let k = 0; k < 3; k++) {
            let temp = data[i * 3 + k];
            data[i * 3 + k] = data[j * 3 + k];
            data[j * 3 + k] = temp;
        }
    };

    return {
        push: (val, arrIdx, eleIdx) => {
            let i = size * 3;
            data[i] = val;
            data[i + 1] = arrIdx;
            data[i + 2] = eleIdx;

            let curr = size++;
            while (curr > 0) {
                let parent = (curr - 1) >> 1;
                if (data[curr * 3] >= data[parent * 3]) break;
                swap(curr, parent);
                curr = parent;
            }
        },
        pop: () => {
            const res = [data[0], data[1], data[2]];
            size--;
            if (size > 0) {
                data.set(data.subarray(size * 3, size * 3 + 3), 0);
                let curr = 0;
                while (true) {
                    let left = (curr << 1) + 1;
                    let right = (curr << 1) + 2;
                    let smallest = curr;
                    if (left < size && data[left * 3] < data[smallest * 3]) smallest = left;
                    if (right < size && data[right * 3] < data[smallest * 3]) smallest = right;
                    if (smallest === curr) break;
                    swap(curr, smallest);
                    curr = smallest;
                }
            }
            return res;
        },
        peekValue: () => data[0],
        isEmpty: () => size === 0
    };
};

/**
 * @param {Array<Array<Array<bigint|number>>>} groups - The 3D data structure.
 * @param {AbortSignal} signal - The signal from an AbortController.
 */
const getTopIntersections = (groups, signal, limit = 20) => {
    // Immediate exit if already aborted
    if (signal?.aborted) return;

    if (groups.length === 0) return [];

    // Optimization: Sort groups so that the smallest groups (fewest elements total) 
    // are evaluated first. This helps advance maxVal much faster when skipping dense groups.
    const sortedGroups = groups.slice().sort((a, b) => {
        let aLen = 0, bLen = 0;
        for (let i = 0; i < a.length; i++) aLen += a[i].length;
        for (let i = 0; i < b.length; i++) bLen += b[i].length;
        return aLen - bLen;
    });

    const numGroups = sortedGroups.length;

    const heaps = sortedGroups.map(group => {
        const h = createLongHeap(group.length);
        group.forEach((arr, idx) => {
            if (arr.length > 0) h.push(arr[0], idx, 0);
        });
        return h;
    });

    const results = [];
    const currentValues = new Float64Array(numGroups);

    for (let i = 0; i < numGroups; i++) {
        if (heaps[i].isEmpty()) return [];
        currentValues[i] = heaps[i].peekValue();
    }

    while (results.length < limit) {
        // ABORT CHECK: Check at the start of every result discovery cycle
        if (signal?.aborted) return;

        let maxVal = currentValues[0];
        for (let i = 1; i < numGroups; i++) {
            if (currentValues[i] > maxVal) maxVal = currentValues[i];
        }

        let allSame = true;
        for (let i = 0; i < numGroups; i++) {
            while (currentValues[i] < maxVal) {
                const [_, arrIdx, eleIdx] = heaps[i].pop();
                const arr = sortedGroups[i][arrIdx];
                let low = eleIdx + 1;
                const high = arr.length - 1;

                if (low <= high) {
                    if (arr[high] < maxVal) {
                        // All remaining elements in this array are less than maxVal.
                        // We skip pushing it back to the heap.
                    } else if (arr[low] >= maxVal) {
                        // The very next element is >= maxVal, so push it.
                        heaps[i].push(arr[low], arrIdx, low);
                    } else {
                        // Galloping search for the first element >= maxVal
                        let bound = 1;
                        const maxBound = high - low;
                        while (bound <= maxBound && arr[low + bound] < maxVal) {
                            bound <<= 1;
                        }
                        let l = low + (bound >> 1);
                        let r = bound <= maxBound ? low + bound : high;
                        
                        let ans = r;
                        while (l <= r) {
                            let mid = (l + r) >> 1;
                            if (arr[mid] >= maxVal) {
                                ans = mid;
                                r = mid - 1;
                            } else {
                                l = mid + 1;
                            }
                        }
                        heaps[i].push(arr[ans], arrIdx, ans);
                    }
                }

                if (heaps[i].isEmpty()) return results;
                currentValues[i] = heaps[i].peekValue();
            }
            if (currentValues[i] > maxVal) {
                maxVal = currentValues[i];
                allSame = false;
            }
        }

        if (allSame) {
            results.push(maxVal);

            for (let i = 0; i < numGroups; i++) {
                const matchVal = maxVal;
                while (!heaps[i].isEmpty() && heaps[i].peekValue() <= matchVal) {
                    const [_, arrIdx, eleIdx] = heaps[i].pop();
                    const arr = sortedGroups[i][arrIdx];
                    let low = eleIdx + 1;
                    const high = arr.length - 1;

                    if (low <= high) {
                        if (arr[high] <= matchVal) {
                            // Skip entirely
                        } else if (arr[low] > matchVal) {
                            heaps[i].push(arr[low], arrIdx, low);
                        } else {
                            // Galloping search for first element > matchVal
                            let bound = 1;
                            const maxBound = high - low;
                            while (bound <= maxBound && arr[low + bound] <= matchVal) {
                                bound <<= 1;
                            }
                            let l = low + (bound >> 1);
                            let r = bound <= maxBound ? low + bound : high;
                            
                            let ans = r;
                            while (l <= r) {
                                let mid = (l + r) >> 1;
                                if (arr[mid] > matchVal) {
                                    ans = mid;
                                    r = mid - 1;
                                } else {
                                    l = mid + 1;
                                }
                            }
                            heaps[i].push(arr[ans], arrIdx, ans);
                        }
                    }
                }

                if (heaps[i].isEmpty()) {
                    // Check if we hit the limit early before advancing the rest
                    if (results.length < limit) return results;
                } else {
                    currentValues[i] = heaps[i].peekValue();
                }
            }
        }
    }

    return results;
};

module.exports = {
    getTopIntersections
};