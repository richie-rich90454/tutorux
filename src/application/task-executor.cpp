#include "tutorux/application/task-executor.hpp"

#include <algorithm>

namespace tutorux::application {

TaskExecutor::TaskExecutor(std::size_t workers) {
    workers = std::clamp<std::size_t>(workers, 1, 4);
    workers_.reserve(workers);
    for (std::size_t index = 0; index < workers; ++index) {
        workers_.emplace_back([this](std::stop_token token) { workerLoop(std::move(token)); });
    }
}

TaskExecutor::~TaskExecutor() {
    join();
}

bool TaskExecutor::submit(std::function<void()> task) {
    if (!task)
        return false;
    {
        const std::scoped_lock lock(mutex_);
        if (stopping_.load(std::memory_order_acquire))
            return false;
        tasks_.push_back(std::move(task));
    }
    condition_.notify_one();
    return true;
}

void TaskExecutor::stop() {
    {
        const std::scoped_lock lock(mutex_);
        if (stopping_.exchange(true, std::memory_order_acq_rel))
            return;
        tasks_.clear();
    }
    for (auto& worker : workers_) {
        if (worker.joinable())
            worker.request_stop();
    }
    condition_.notify_all();
}

void TaskExecutor::join() {
    stop();
    for (auto& worker : workers_) {
        if (worker.joinable())
            worker.join();
    }
}

std::size_t TaskExecutor::queuedCount() const {
    const std::scoped_lock lock(mutex_);
    return tasks_.size();
}

std::size_t TaskExecutor::applicationThreadCount() noexcept {
    return 1;
}

void TaskExecutor::workerLoop(std::stop_token token) {
    for (;;) {
        std::function<void()> task;
        {
            std::unique_lock lock(mutex_);
            condition_.wait(lock, token, [this] { return !tasks_.empty(); });
            if (token.stop_requested())
                return;
            if (tasks_.empty())
                continue;
            task = std::move(tasks_.front());
            tasks_.pop_front();
        }
        try {
            task();
        } catch (...) {
            // Tasks own their error reporting; a failure must not kill the pool.
        }
    }
}

} // namespace tutorux::application
