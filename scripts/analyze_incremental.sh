#!/bin/bash

# 增量更新分析脚本
# 分析当前工作流的增量更新机制是否有效

set -e

echo "🔍 分析增量更新机制..."

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "📋 当前配置:"
echo "1. 工作流触发: 每日凌晨2点 + 手动触发"
echo "2. 变更检测: git status --porcelain"
echo "3. 版本管理: 基于Git标签的自动递增"

echo ""
echo "🔧 增量更新关键点分析:"

echo ""
echo "✅ 优点:"
echo "- Git哈希比较: 脚本通过比较BEFORE_HASH和AFTER_HASH检测远程仓库更新"
echo "- 文件变更检测: 工作流使用git status --porcelain检测本地文件变更"
echo "- 条件执行: 只有在有变更时才执行版本更新和标签创建"
echo "- rsync同步: 使用rsync --exclude='.git' 高效同步文件"

echo ""
echo "⚠️  潜在问题:"

# 检查1: Git状态检测的有效性
echo ""
echo "🔸 问题1: Git状态检测时机"
echo "  - 当前逻辑: update.sh -> git status检测 -> 版本更新"
echo "  - 风险: 如果update.sh没有产生实际的git变更，检测可能失效"

# 检查2: 工作目录状态
echo ""
echo "🔸 问题2: 工作目录状态检查"
if [ -n "$(git status --porcelain)" ]; then
    echo "  - 当前状态: 有未提交的变更"
    git status --porcelain | head -5
    if [ $(git status --porcelain | wc -l) -gt 5 ]; then
        echo "  - (还有更多文件...)"
    fi
else
    echo "  - 当前状态: 工作目录干净"
fi

# 检查3: 版本同步状态
echo ""
echo "🔸 问题3: 版本同步检查"
CURRENT_VERSION=$(jq -r '.version' "$PROJECT_ROOT/package.json")
LATEST_TAG=$(git tag -l | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
if [ -n "$LATEST_TAG" ]; then
    LATEST_VERSION=${LATEST_TAG#v}
    echo "  - package.json版本: $CURRENT_VERSION"
    echo "  - 最新Git标签: $LATEST_TAG ($LATEST_VERSION)"
    if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
        echo "  - 状态: 版本同步 ✅"
    else
        echo "  - 状态: 版本不同步 ⚠️"
    fi
else
    echo "  - 没有Git标签"
fi

echo ""
echo "🔧 建议改进:"
echo "1. 在update.sh中添加更明确的变更检测"
echo "2. 考虑添加文件内容哈希比较"
echo "3. 增加调试输出显示具体变更的文件"
echo "4. 考虑添加变更摘要生成"

echo ""
echo "📊 总结:"
echo "当前机制基本可以实现增量更新，但存在一些潜在的边界情况问题。"
echo "主要依赖Git的变更检测，这在大多数情况下是可靠的。"
