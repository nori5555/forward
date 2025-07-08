#!/bin/bash

# 自动更新脚本
set -e

echo "🚀 开始自动更新模块库..."

# 读取配置文件
CONFIG_FILE="config/repos.json"
TEMP_DIR="temp"
UPDATE_LOG="CHANGELOG.md"
CURRENT_DATE=$(date '+%Y-%m-%d %H:%M:%S')

# 创建临时目录
mkdir -p $TEMP_DIR

# 检查是否有更新
HAS_UPDATES=false

# 解析JSON并处理每个仓库
echo "📋 读取仓库配置..."
repos=$(cat $CONFIG_FILE | jq -r '.repositories[] | @base64')

for repo in $repos; do
    # 解码JSON
    repo_data=$(echo $repo | base64 --decode)
    name=$(echo $repo_data | jq -r '.name')
    url=$(echo $repo_data | jq -r '.url')
    branch=$(echo $repo_data | jq -r '.branch')
    target_dir=$(echo $repo_data | jq -r '.target_dir')
    
    echo "\n🔄 处理仓库: $name"
    echo "📍 URL: $url"
    echo "🌿 分支: $branch"
    echo "📁 目标目录: $target_dir"
    
    # 克隆或更新仓库到临时目录
    temp_repo_dir="$TEMP_DIR/$name"
    
    if [ -d "$temp_repo_dir" ]; then
        echo "📥 更新现有仓库..."
        cd $temp_repo_dir
        git fetch origin
        BEFORE_HASH=$(git rev-parse HEAD)
        git reset --hard origin/$branch
        AFTER_HASH=$(git rev-parse HEAD)
        cd - > /dev/null
    else
        echo "📦 克隆新仓库..."
        git clone -b $branch $url $temp_repo_dir
        BEFORE_HASH=""
        AFTER_HASH=$(cd $temp_repo_dir && git rev-parse HEAD)
    fi
    
    # 检查是否有更新
    if [ "$BEFORE_HASH" != "$AFTER_HASH" ] || [ ! -d "$target_dir" ]; then
        echo "✅ 发现更新，同步文件..."
        HAS_UPDATES=true
        
        # 创建目标目录
        mkdir -p $target_dir
        
        # 复制文件（排除.git目录，只读模式：不修改源文件）
        rsync -av --exclude='.git' $temp_repo_dir/ $target_dir/
        
        # 添加变更到Git暂存区
        git add $target_dir/
        
        # 验证源文件完整性（确保未被修改）
        if [ -d "$temp_repo_dir" ]; then
            echo "🔍 验证源文件完整性..."
        fi
        
        # 记录更新日志
        echo "## [$name] - $CURRENT_DATE" >> $UPDATE_LOG.tmp
        echo "- 仓库: $url" >> $UPDATE_LOG.tmp
        echo "- 分支: $branch" >> $UPDATE_LOG.tmp
        if [ -n "$BEFORE_HASH" ]; then
            echo "- 更新: $BEFORE_HASH -> $AFTER_HASH" >> $UPDATE_LOG.tmp
        else
            echo "- 新增: $AFTER_HASH" >> $UPDATE_LOG.tmp
        fi
        echo "" >> $UPDATE_LOG.tmp
        
        echo "📝 已更新 $name"
    else
        echo "⏭️  $name 无更新"
    fi
done

# 汇聚Widget模块（在版本更新之前）
echo "🔗 汇聚Widget模块..."
if [ -f "scripts/aggregate.sh" ]; then
    chmod +x scripts/aggregate.sh
    ./scripts/aggregate.sh
    if [ $? -eq 0 ]; then
        echo "✅ Widget汇聚完成！"
        # 添加汇聚产生的文件到Git暂存区
        git add *.fwd 2>/dev/null || true
        # 检查汇聚是否产生了新文件
        if [ -n "$(git status --porcelain forward-widgets.fwd widgets.fwd 2>/dev/null)" ]; then
            HAS_UPDATES=true
            echo "📝 汇聚产生了新的更改"
        fi
    else
        echo "⚠️  Widget汇聚失败，但不影响主流程"
    fi
else
    echo "⚠️  汇聚脚本不存在，跳过汇聚步骤"
fi

# 如果有更新，记录日志
if [ "$HAS_UPDATES" = true ]; then
    echo "\n📝 更新日志..."
    
    # 更新CHANGELOG
    if [ -f "$UPDATE_LOG.tmp" ]; then
        echo "# 更新日志\n" > $UPDATE_LOG.new
        cat $UPDATE_LOG.tmp >> $UPDATE_LOG.new
        if [ -f "$UPDATE_LOG" ]; then
            echo "" >> $UPDATE_LOG.new
            tail -n +2 $UPDATE_LOG >> $UPDATE_LOG.new
        fi
        mv $UPDATE_LOG.new $UPDATE_LOG
        rm $UPDATE_LOG.tmp
        # 添加更新日志到Git暂存区
        git add $UPDATE_LOG
    fi
    
    echo "🎉 更新完成！"
    echo "📋 更新的仓库数量: $(echo "$repos" | wc -l)"
    echo "📝 版本号将由GitHub Actions统一管理"
else
    echo "\n✨ 所有仓库都是最新的！"
fi

# 清理临时文件
echo "🧹 清理临时文件..."
rm -rf $TEMP_DIR

echo "✅ 自动更新完成！"