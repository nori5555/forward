import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import { pipeline } from 'stream/promises';
import { createWriteStream, createReadStream } from 'fs';
import zlib from 'zlib';
import readline from 'readline';
import { findByImdbId, getTmdbDetails } from './src/utils/tmdb_api.js'; 
import { analyzeAndTagItem } from './src/core/analyzer.js';

const MAX_CONCURRENT_ENRICHMENTS = 80;
const MAX_DOWNLOAD_AGE_MS = 20 * 60 * 60 * 1000;
const MIN_VOTES = 1000; 
const MIN_YEAR = 1990; 
const MIN_RATING = 6.0; 
const ALLOWED_TITLE_TYPES = new Set(['movie', 'tvSeries', 'tvMiniSeries', 'tvMovie']);
const CURRENT_YEAR = new Date().getFullYear();
const RECENT_YEAR_THRESHOLD = CURRENT_YEAR - 1;
const ITEMS_PER_PAGE = 30; 
const SORT_CONFIG = {
    'hs': 'hotness_score',
    'r': 'vote_average',
    'd': 'default_order',
};

const DATASET_DIR = './datasets';
const TEMP_DIR = './temp';
const FINAL_OUTPUT_DIR = './dist';
const DATA_LAKE_FILE = path.join(FINAL_OUTPUT_DIR, 'datalake.jsonl');

const DATASETS = {
    basics: { url: 'https://datasets.imdbws.com/title.basics.tsv.gz', local: 'title.basics.tsv' },
    ratings: { url: 'https://datasets.imdbws.com/title.ratings.tsv.gz', local: 'title.ratings.tsv' },
};

const REGIONS = ['all', 'region:chinese', 'region:us-eu', 'region:east-asia', 'country:cn', 'country:hk', 'country:tw', 'country:us', 'country:gb', 'country:jp', 'country:kr', 'country:fr', 'country:de', 'country:ca', 'country:au'];
const GENRES_AND_THEMES = ['genre:爱情', 'genre:冒险', 'genre:悬疑', 'genre:惊悚', 'genre:恐怖', 'genre:科幻', 'genre:奇幻', 'genre:动作', 'genre:喜剧', 'genre:剧情', 'genre:历史', 'genre:战争', 'genre:犯罪', 'theme:whodunit', 'theme:spy', 'theme:courtroom', 'theme:slice-of-life', 'theme:wuxia', 'theme:superhero', 'theme:cyberpunk', 'theme:space-opera', 'theme:time-travel', 'theme:post-apocalyptic', 'theme:mecha', 'theme:zombie', 'theme:monster', 'theme:ghost', 'theme:magic', 'theme:gangster', 'theme:film-noir', 'theme:serial-killer', 'theme:xianxia', 'theme:kaiju', 'theme:isekai'];
const YEARS = Array.from({length: CURRENT_YEAR - 1990 + 1}, (_, i) => 1990 + i).reverse();

async function downloadAndUnzipWithCache(url, localPath, maxAgeMs) {
    const dir = path.dirname(localPath);
    await fs.mkdir(dir, { recursive: true });
    try {
        const stats = await fs.stat(localPath);
        if (Date.now() - stats.mtimeMs < maxAgeMs) {
            console.log(`  Cache hit for ${path.basename(localPath)}.`);
            return;
        }
    } catch (e) {}
    console.log(`  Downloading from: ${url}`);
    const response = await fetch(url, { headers: { 'User-Agent': 'IMDb-Builder/1.0' } });
    if (!response.ok) throw new Error(`Failed to download ${url}: ${response.statusText}`);
    const gunzip = zlib.createGunzip();
    const destination = createWriteStream(localPath);
    await pipeline(response.body, gunzip, destination);
    console.log(`  Download and unzip complete for ${path.basename(localPath)}.`);
}

async function processTsvByLine(filePath, processor) {
    const fileStream = createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let isFirstLine = true;
    for await (const line of rl) {
        if (isFirstLine) { isFirstLine = false; continue; }
        if (line && line.includes('\t')) processor(line);
    }
}

async function processInParallel(items, concurrency, task) {
    const queue = [...items]; 
    let processedCount = 0; 
    const totalCount = items.length;
    const worker = async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item) {
                await task(item);
                processedCount++;
                if (processedCount % 50 === 0 || processedCount === totalCount) {
                    process.stdout.write(`  Progress: ${processedCount} / ${totalCount} \r`);
                }
            }
        }
    };
    const workers = Array(concurrency).fill(null).map(() => worker());
    await Promise.all(workers);
    if (totalCount > 0) process.stdout.write('\n');
}

async function buildDataLake() {
    console.log('\nPHASE 1-3: Building Data Lake (Incremental Mode - V3 Simplified)...');
    
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.mkdir(FINAL_OUTPUT_DIR, { recursive: true });

    const existingDataMap = new Map();
    try {
        await fs.access(DATA_LAKE_FILE);
        console.log(`  Found existing data lake: ${DATA_LAKE_FILE}. Loading...`);
        const rl = readline.createInterface({ input: createReadStream(DATA_LAKE_FILE), crlfDelay: Infinity });
        for await (const line of rl) {
            if (line.trim()) {
                const item = JSON.parse(line);
                if (item.imdb_id) existingDataMap.set(item.imdb_id, item);
            }
        }
        console.log(`  Loaded ${existingDataMap.size} items from existing data lake.`);
    } catch (e) {
        console.log('  No existing data lake found. Starting a full build.');
    }

    console.log('\nPHASE A: Building indexes and creating authoritative ID pool...');
    const ratingsIndex = new Map();
    const ratingsPath = path.join(TEMP_DIR, DATASETS.ratings.local);
    await downloadAndUnzipWithCache(DATASETS.ratings.url, ratingsPath, MAX_DOWNLOAD_AGE_MS);
    await processTsvByLine(ratingsPath, (line) => {
        const [tconst, averageRating, numVotes] = line.split('\t');
        if ( (parseInt(numVotes, 10) || 0) >= MIN_VOTES && (parseFloat(averageRating) || 0) >= MIN_RATING) {
            ratingsIndex.set(tconst, true);
        }
    });
    console.log(`  Ratings index built for ${ratingsIndex.size} items.`);

    const currentValidIdPool = new Set();
    const basicsPath = path.join(TEMP_DIR, DATASETS.basics.local);
    await downloadAndUnzipWithCache(DATASETS.basics.url, basicsPath, MAX_DOWNLOAD_AGE_MS);
    await processTsvByLine(basicsPath, (line) => {
        const [tconst, titleType, , , isAdult, startYear] = line.split('\t');
        if (tconst.startsWith('tt') && isAdult !== '1' && ALLOWED_TITLE_TYPES.has(titleType) && (parseInt(startYear, 10) || 0) >= MIN_YEAR && ratingsIndex.has(tconst)) {
            currentValidIdPool.add(tconst);
        }
    });
    console.log(`  Authoritative ID pool created with ${currentValidIdPool.size} items from latest IMDb dump.`);

    console.log('\nPHASE B: Adjudicating cache and identifying new items...');
    const finalKeptItems = [];
    for (const [imdbId, item] of existingDataMap.entries()) {
        if (currentValidIdPool.has(imdbId)) {
            finalKeptItems.push(item);
        }
    }
    console.log(`  Kept ${finalKeptItems.length} valid items from cache.`);
    
    const brandNewIds = new Set();
    for (const imdbId of currentValidIdPool) {
        if (!existingDataMap.has(imdbId)) {
            brandNewIds.add(imdbId);
        }
    }
    console.log(`  Identified ${brandNewIds.size} brand new items to be enriched.`);

    const newlyEnrichedItems = [];
    if (brandNewIds.size > 0) {
        console.log(`\nPHASE C: Enriching ${brandNewIds.size} new items via TMDB API...`);
        const enrichmentTask = async (id) => {
            try {
                const info = await findByImdbId(id);
                if (!info || !info.id || !info.media_type) return;
                const details = await getTmdbDetails(info.id, info.media_type);
                if (details) {
                    const analyzedItem = analyzeAndTagItem(details);
                    if (analyzedItem) newlyEnrichedItems.push(analyzedItem);
                }
            } catch (error) {
                console.warn(`  Skipping ID ${id} due to enrichment error: ${error.message}`);
            }
        };
        await processInParallel(Array.from(brandNewIds), MAX_CONCURRENT_ENRICHMENTS, enrichmentTask);
    } else {
        console.log('\nPHASE C: No new items to enrich. Skipping.');
    }
    
    const finalDatabase = [...finalKeptItems, ...newlyEnrichedItems];
    console.log(`\nPHASE D: Writing final data lake with ${finalDatabase.length} items...`);
    const writeStream = createWriteStream(DATA_LAKE_FILE);
    for (const item of finalDatabase) {
        writeStream.write(JSON.stringify(item) + '\n');
    }
    await new Promise(resolve => writeStream.end(resolve));
    console.log(`  Data Lake written to ${DATA_LAKE_FILE}`);

    return finalDatabase;
}


async function shardDatabase(database) {
    console.log('\nPHASE 4: Sharding, Sorting, and Paginating database...');
    
    if (!database || database.length === 0) {
        console.warn('  Database is empty. Nothing to shard.');
        return;
    }
    
    console.log('  Cleaning up old shard directories...');
    const dirsToClean = ['hot', 'tag', 'year', 'movies', 'tvseries', 'anime'];
    for (const dir of dirsToClean) {
        await fs.rm(path.join(FINAL_OUTPUT_DIR, dir), { recursive: true, force: true });
    }
    await fs.rm(path.join(FINAL_OUTPUT_DIR, 'manifest.json'), { force: true });

    console.log(`  Processing ${database.length} items for sharding.`);

    const validForStats = database.filter(i => i.vote_count > 100);
    const totalRating = validForStats.reduce((sum, item) => sum + (item.vote_average || 0), 0);
    const GLOBAL_AVERAGE_RATING = validForStats.length > 0 ? totalRating / validForStats.length : 6.8;
    const sortedVotes = validForStats.map(i => i.vote_count).sort((a,b) => a - b);
    const MINIMUM_VOTES_THRESHOLD = sortedVotes[Math.floor(sortedVotes.length * 0.75)] || 500;
    console.log(`  Global Stats: AvgRating=${GLOBAL_AVERAGE_RATING.toFixed(2)}, MinVotes=${MINIMUM_VOTES_THRESHOLD}`);

    database.forEach(item => {
        const R = item.vote_average || 0;
        const v = item.vote_count || 0;
        const yearDiff = Math.max(0, CURRENT_YEAR - (item.release_year || 1970));
        const bayesianRating = (v / (v + MINIMUM_VOTES_THRESHOLD)) * R + (MINIMUM_VOTES_THRESHOLD / (v + MINIMUM_VOTES_THRESHOLD)) * GLOBAL_AVERAGE_RATING;
        item.hotness_score = Math.log10((item.popularity || 0) + 1) * (1 / Math.sqrt(yearDiff + 2)) * bayesianRating;
        item.default_order = item.popularity || 0;
    });

    console.log('  Generating sorted and paginated shards...');
    let shardGroupCount = 0;
    const contentTypes = ['all', 'movie', 'tv', 'anime'];
    const filterData = (baseData, type, region) => {
        let filtered = (type !== 'all') ? baseData.filter(i => i.mediaType === type) : baseData;
        return (region !== 'all') ? filtered.filter(i => i.semantic_tags.includes(region)) : filtered;
    };
    const processShardGroup = async (groupName, baseDataFilter, dimension1, dimension2, dimension3) => {
        console.log(`  Processing group: ${groupName}...`);
        for (const d1 of dimension1) {
            const dataD1 = baseDataFilter(d1);
            for (const d2 of dimension2) {
                for (const d3 of dimension3) {
                    const data = filterData(dataD1, d2, d3);
                    if (data.length > 0) {
                        const pathName = `${groupName}/${String(d1).replace(':', '_')}/${d2}/${d3.replace(':', '_')}`;
                        await processAndWriteSortedPaginatedShards(pathName, data);
                        shardGroupCount++;
                    }
                }
            }
        }
    };
    
    console.log('  Processing group: Recent Hot...');
    const recentHotBase = database.filter(i => i.release_year >= RECENT_YEAR_THRESHOLD);
    for (const type of contentTypes) {
        for (const region of REGIONS) {
            const data = filterData(recentHotBase, type, region);
            if(data.length > 0) {
                await processAndWriteSortedPaginatedShards(`hot/${type}/${region.replace(':', '_')}`, data);
                shardGroupCount++;
            }
        }
    }
    
    await processShardGroup('tag', (tag) => (tag === 'all') ? database : database.filter(i => i.semantic_tags.includes(tag)), ['all', ...GENRES_AND_THEMES], contentTypes, REGIONS);
    await processShardGroup('year', (year) => (year === 'all') ? database : database.filter(i => i.release_year === year), ['all', ...YEARS], contentTypes, REGIONS);
    
    console.log('  Processing group: Direct Types (Movies, TV, Anime)...');
    const directTypes = [{ name: 'movies', mt: 'movie' }, { name: 'tvseries', mt: 'tv' }, { name: 'anime', mt: 'anime' }];
    for (const typeInfo of directTypes) {
        let baseData = database.filter(i => i.mediaType === typeInfo.mt);
        for (const region of REGIONS) {
            let data = (region === 'all') ? baseData : baseData.filter(i => i.semantic_tags.includes(region));
            if(data.length > 0) {
                await processAndWriteSortedPaginatedShards(`${typeInfo.name}/${region.replace(':', '_')}`, data);
                shardGroupCount++;
            }
        }
    }

    await fs.writeFile(path.join(FINAL_OUTPUT_DIR, 'manifest.json'), JSON.stringify({
        buildTimestamp: new Date().toISOString(), regions: REGIONS, tags: GENRES_AND_THEMES, years: YEARS,
        itemsPerPage: ITEMS_PER_PAGE, sortOptions: Object.keys(SORT_CONFIG), contentTypes: contentTypes
    }));
    console.log(`  ✅ Sharding, Sorting, and Paginating complete. Generated ${shardGroupCount} distinct shard groups.`);
}

async function processAndWriteSortedPaginatedShards(basePath, data) {
    const metadata = { total_items: data.length, items_per_page: ITEMS_PER_PAGE, pages: {} };
    for (const [sortPrefix, internalKey] of Object.entries(SORT_CONFIG)) {
        const sortedData = [...data].sort((a, b) => (b[internalKey] || 0) - (a[internalKey] || 0));
        const numPages = Math.ceil(sortedData.length / ITEMS_PER_PAGE);
        metadata.pages[sortPrefix] = numPages;
        for (let page = 1; page <= numPages; page++) {
            const start = (page - 1) * ITEMS_PER_PAGE;
            const pageData = sortedData.slice(start, start + ITEMS_PER_PAGE).map(minifyItem);
            const finalPath = path.join(FINAL_OUTPUT_DIR, basePath, `by_${sortPrefix}`, `page_${page}.json`);
            await fs.mkdir(path.dirname(finalPath), { recursive: true });
            await fs.writeFile(finalPath, JSON.stringify(pageData));
        }
    }
    const metaPath = path.join(FINAL_OUTPUT_DIR, basePath, 'meta.json');
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(metadata));
}

function minifyItem(item) {
    return {
        id: item.id,
        p: item.poster_path,
        b: item.backdrop_path,
        t: item.title,
        r: item.vote_average,
        y: item.release_year,
        rd: item.release_date,
        hs: parseFloat(item.hotness_score.toFixed(3)),
        d: parseFloat(item.default_order.toFixed(3)),
        mt: item.mediaType,
        o: item.overview
    };
}

async function main() {
    console.log('Starting IMDb Sharded Build Process (Optimized & Corrected V3)...');
    const startTime = Date.now();
    try {
        const finalDatabase = await buildDataLake();
        await shardDatabase(finalDatabase);
        const duration = (Date.now() - startTime) / 1000;
        console.log(`\n✅ Build process successful! Took ${duration.toFixed(2)} seconds.`);
    } catch (error) {
        console.error('\n❌ FATAL ERROR during build process:', error);
        process.exit(1);
    } finally {
        console.log('Build finished.');
    }
}

main();
