#!/bin/bash

# 测试增量更新机制
# 验证修复后的update.sh是否能正确检测变更

set -e

echo "🧪 测试增量更新机制..."

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "📋 测试前状态:"
echo "Git状态:"
git status --porcelain | head -3

echo ""
echo "🚀 运行update.sh脚本..."
cd "$PROJECT_ROOT"
bash scripts/update.sh

echo ""
echo "📋 测试后状态:"
echo "Git状态:"
if [ -n "$(git status --porcelain)" ]; then
    echo "✅ 检测到变更:"
    git status --porcelain | head -5
    echo ""
    echo "🎯 增量更新机制工作正常！"
    echo "工作流应该能够检测到这些变更并执行版本更新。"
else
    echo "❌ 没有检测到变更"
    echo "可能的原因:"
    echo "1. 所有仓库都是最新的"
    echo "2. rsync没有产生文件变更"
    echo "3. git add没有正确执行"
fi

echo ""
echo "📊 结论:"
echo "如果有文件变更，现在应该可以被Git检测到了。"
