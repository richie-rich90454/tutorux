#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace tutorux::application {

// Bounded worker pool. Completed work returns its worker to the pool instead of
// leaving a joinable thread behind, so long sessions do not accumulate handles.
class TaskExecutor final {
  public:
    explicit TaskExecutor(std::size_t workers = 3);
    ~TaskExecutor();

    TaskExecutor(const TaskExecutor&) = delete;
    TaskExecutor& operator=(const TaskExecutor&) = delete;

    bool submit(std::function<void()> task);
    void stop();
    void join();

    [[nodiscard]] std::size_t workerCount() const noexcept {
        return workers_.size();
    }
    [[nodiscard]] std::size_t queuedCount() const;
    [[nodiscard]] bool running() const noexcept {
        return !stopping_.load(std::memory_order_acquire);
    }

    static std::size_t applicationThreadCount() noexcept;

  private:
    void workerLoop(std::stop_token token);

    mutable std::mutex mutex_;
    std::condition_variable_any condition_;
    std::deque<std::function<void()>> tasks_;
    std::vector<std::jthread> workers_;
    std::atomic_bool stopping_{false};
};

} // namespace tutorux::application
