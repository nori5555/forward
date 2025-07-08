// analyzer.js

const KEYWORD_TO_THEME_MAP = {
    // 科幻
    'cyberpunk': 'theme:cyberpunk', 'dystopia': 'theme:cyberpunk', 'virtual reality': 'theme:cyberpunk', 'artificial intelligence': 'theme:cyberpunk', 'neo-noir': 'theme:cyberpunk',
    'space opera': 'theme:space-opera', 'alien': 'theme:space-opera', 'galaxy': 'theme:space-opera', 'spaceship': 'theme:space-opera',
    'time travel': 'theme:time-travel', 'time loop': 'theme:time-travel', 'paradox': 'theme:time-travel',
    'post-apocalyptic': 'theme:post-apocalyptic', 'dystopian': 'theme:post-apocalyptic',
    'superhero': 'theme:superhero', 'marvel comics': 'theme:superhero', 'dc comics': 'theme:superhero', 'comic book': 'theme:superhero',
    'mecha': 'theme:mecha', 'giant robot': 'theme:mecha',
    'zombie': 'theme:zombie', 'undead': 'theme:zombie',
    'vampire': 'theme:vampire', 'werewolf': 'theme:werewolf', 'monster': 'theme:monster', 'kaiju': 'theme:kaiju', 
    'ghost': 'theme:ghost', 'haunting': 'theme:ghost', 'supernatural horror': 'theme:ghost',
    'slasher': 'theme:slasher', 'body horror': 'theme:body-horror', 'folk horror': 'theme:folk-horror',
    // 奇幻
    'magic': 'theme:magic', 'sword and sorcery': 'theme:magic',
    // 犯罪/悬疑
    'gangster': 'theme:gangster', 'mafia': 'theme:gangster', 'mobster': 'theme:gangster',
    'heist': 'theme:heist', 'film-noir': 'theme:film-noir', 'hardboiled': 'theme:film-noir',
    'conspiracy': 'theme:conspiracy', 'spy': 'theme:spy', 'espionage': 'theme:spy', 'assassin': 'theme:assassin',
    'serial killer': 'theme:serial-killer', 'whodunit': 'theme:whodunit', 'courtroom drama': 'theme:courtroom',
    // 亚洲文化
    'wuxia': 'theme:wuxia', 'martial arts': 'theme:wuxia', 'kung fu': 'theme:wuxia',
    'xianxia': 'theme:xianxia', 'samurai': 'theme:samurai', 'ninja': 'theme:ninja', 'yakuza': 'theme:yakuza',
    'tokusatsu': 'theme:tokusatsu',
    'isekai': 'theme:isekai', 'slice of life': 'theme:slice-of-life', 'high school': 'theme:slice-of-life',
    // 其他
    'found footage': 'theme:found-footage',
};

// 类型门控：指定哪些主题需要匹配特定的基础类型
const GATED_THEMES = {
    'theme:ghost': ['恐怖', '惊悚', '悬疑'],
    'theme:zombie': ['恐怖'],
    'theme:vampire': ['恐怖', '奇幻'],
    'theme:werewolf': ['恐怖', '奇幻'],
    'theme:monster': ['恐怖', '科幻', '奇幻'],
    'theme:slasher': ['恐怖', '惊悚'],
    'theme:body-horror': ['恐怖'],
    'theme:kaiju': ['科幻', '动作', '恐怖'],
    'theme:serial-killer': ['犯罪', '惊悚', '恐怖', '悬疑'],
};

// 预编译正则表达式，使用单词边界 (\b)
const COMPILED_REGEX_MAP = {};
for (const [keyword, theme] of Object.entries(KEYWORD_TO_THEME_MAP)) {
    // 创建一个只匹配独立单词的正则表达式，忽略大小写
    COMPILED_REGEX_MAP[keyword] = {
        regex: new RegExp(`\\b${keyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i'),
        theme: theme
    };
}


export function analyzeAndTagItem(item) {
    if (!item) return null;

    const tags = new Set();
    const release_date = item.release_date || item.first_air_date;
    const year = release_date ? new Date(release_date).getFullYear() : null;

    // 1. 基础类型标签
    const mediaType = item.media_type || (item.seasons ? 'tv' : 'movie');
    tags.add(`type:${mediaType}`);

    // 2. 类型标签
    const genreNames = new Set();
    (item.genres || []).forEach(g => { if (g.name) genreNames.add(g.name); });
    genreNames.forEach(name => tags.add(`genre:${name}`));
    const isAnimation = genreNames.has('动画');
    if (isAnimation) tags.add('type:animation');

    // 3. 年代标签
    if (year) tags.add(`decade:${Math.floor(year / 10) * 10}s`);

    // 4. 语言标签
    const languages = new Set();
    // 优先级 1: 原始语言
    if (item.original_language) {
        languages.add(item.original_language.split('-')[0]); // 'zh-CN' -> 'zh'
    }
    // 优先级 2: 可用的翻译数据 (代表影片有该语言的元数据)
    item.translations?.translations?.forEach(t => {
        languages.add(t.iso_639_1);
    });
    languages.forEach(lang => tags.add(`lang:${lang}`));

    // 5. 制作国家/地区标签 (country:xx)
    const countries = new Set();
    (item.origin_country || []).forEach(c => countries.add(c.toLowerCase()));
    (item.production_countries || []).forEach(pc => countries.add(pc.iso_3166_1.toLowerCase()));
    countries.forEach(c => tags.add(`country:${c}`));

    // 6. 聚合地区标签 (region:xx) - 基于新的语言和国家数据，逻辑更健壮
    // 判定为欧美地区
    if (languages.has('en') || countries.has('us') || countries.has('gb') || countries.has('ca') || countries.has('au') || countries.has('fr') || countries.has('de')) {
        tags.add('region:us-eu');
    }
    // 判定为东亚地区（日韩）
    if (languages.has('ja') || languages.has('ko') || countries.has('jp') || countries.has('kr')) {
        tags.add('region:east-asia');
    }
    // 判定为华语地区 (语言优先)
    if (languages.has('zh') || countries.has('cn') || countries.has('hk') || countries.has('tw') || countries.has('sg')) {
        tags.add('region:chinese');
    }
    
    // 7. 关键词/主题/风格/情绪标签
    const tmdbKeywords = (item.keywords?.keywords || item.keywords?.results || []).map(k => k.name.toLowerCase());
    const foundThemes = new Set();

    tmdbKeywords.forEach(tmdbKeyword => {
        for (const { regex, theme } of Object.values(COMPILED_REGEX_MAP)) {
            if (regex.test(tmdbKeyword)) {
                foundThemes.add(theme);
            }
        }
    });

    // 应用类型门控
    foundThemes.forEach(theme => {
        const requiredGenres = GATED_THEMES[theme];
        if (requiredGenres) {
            const genreGatePassed = requiredGenres.some(requiredGenre => genreNames.has(requiredGenre));
            if (genreGatePassed) {
                tags.add(theme);
            }
        } else {
            tags.add(theme);
        }
    });

    // 8. 聚合分类标签 
    if (tags.has('type:tv')) {
        if (tags.has('region:us-eu')) tags.add('category:us-eu_tv');
        if (tags.has('region:east-asia')) tags.add('category:east-asia_tv');
        if (tags.has('region:chinese')) tags.add('category:chinese_tv');
    }
    if (tags.has('type:animation')) {
        if (tags.has('country:jp')) tags.add('category:jp_anime');
        if (tags.has('country:cn')) tags.add('category:cn_anime');
    }

    // --- 提取中文信息  ---
    const chineseTranslation = item.translations?.translations?.find(t => t.iso_639_1 === 'zh' || t.iso_639_1 === 'zh-CN');
    const title_zh = chineseTranslation?.data?.title || chineseTranslation?.data?.name || item.title || item.name;
    const overview_zh = chineseTranslation?.data?.overview || item.overview;

    // --- 确定统一的 mediaType ---
    let finalMediaType = 'movie'; 
    if (tags.has('type:tv')) {
        finalMediaType = 'tv';
    }
    if (tags.has('type:animation')) {
        finalMediaType = 'anime'; 
    }

    return {
        id: item.id,
        imdb_id: item.external_ids?.imdb_id,
        build_timestamp: new Date().toISOString(),
        title: title_zh,
        overview: overview_zh,
        poster_path: item.poster_path,
        backdrop_path: item.backdrop_path,
        release_date: release_date,
        release_year: year,
        vote_average: item.vote_average,
        vote_count: item.vote_count,
        popularity: item.popularity,
        mediaType: finalMediaType,
        semantic_tags: Array.from(tags),
    };
}
