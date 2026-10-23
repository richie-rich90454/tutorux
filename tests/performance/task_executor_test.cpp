#include "tutorux/application/task-executor.hpp"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

int main() {
    using namespace std::chrono_literals;

    tutorux::application::TaskExecutor executor(3);
    if (executor.workerCount() != 3) {
        std::cerr << "executor did not start exactly three workers\n";
        return 1;
    }

    std::atomic<int> completed{0};
    for (int index = 0; index < 200; ++index) {
        if (!executor.submit([&completed] {
                ++completed;
                std::this_thread::sleep_for(1ms);
            })) {
            std::cerr << "executor rejected a task while running\n";
            return 1;
        }
    }

    const auto deadline = std::chrono::steady_clock::now() + 20s;
    while (completed.load() != 200 && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(5ms);

    if (completed.load() != 200) {
        std::cerr << "executor completed only " << completed.load() << " of 200 tasks\n";
        return 1;
    }
    if (executor.workerCount() > 4) {
        std::cerr << "executor grew past four workers\n";
        return 1;
    }
    if (executor.queuedCount() != 0) {
        std::cerr << "executor retained completed work in its queue\n";
        return 1;
    }

    executor.join();
    if (executor.running()) {
        std::cerr << "executor still reports running after join\n";
        return 1;
    }
    return 0;
}
