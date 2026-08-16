// 等待指定时间后继续
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 调用 DeepSeek，并在服务器繁忙时自动重试。
 *
 * 最多请求 3 次：
 * 第一次失败后等待 2 秒；
 * 第二次失败后等待 5 秒；
 * 第三次仍失败才返回错误。
 */
async function callDeepSeekWithRetry(requestBody) {
    const MAX_ATTEMPTS = 3;

    // 这些错误通常属于暂时性问题，可以自动重试
    const RETRYABLE_STATUS = new Set([
        429, // 请求过于频繁
        500, // DeepSeek 内部错误
        502, // 上游服务错误
        503, // DeepSeek 服务器繁忙
        504  // 请求超时
    ]);

    // 第一次失败等 2 秒，第二次失败等 5 秒
    const RETRY_DELAYS = [0, 2000, 5000];

    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();

        // 单次请求超过 30 秒就主动停止，避免一直等到 Vercel 300 秒超时
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, 30000);

        let response;
        let rawText = '';
        let attemptError;

        try {
            response = await fetch(
                'https://api.deepseek.com/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                }
            );

            // 先按普通文字读取，便于保留 DeepSeek 的错误信息
            rawText = await response.text();

        } catch (error) {
            if (error.name === 'AbortError') {
                attemptError = new Error('DeepSeek 单次请求超过 30 秒');
                attemptError.status = 504;
            } else {
                attemptError = new Error(
                    `连接 DeepSeek 失败：${error.message}`
                );
                attemptError.status = 503;
            }
        } finally {
            clearTimeout(timeoutId);
        }

        // 成功联系到 DeepSeek 后，检查它返回的状态
        if (!attemptError && response) {
            if (!response.ok) {
                attemptError = new Error(
                    `DeepSeek API 报错：${response.status} - ${rawText.slice(0, 800)}`
                );
                attemptError.status = response.status;

            } else {
                let data;

                try {
                    data = JSON.parse(rawText);
                } catch (error) {
                    attemptError = new Error('DeepSeek 返回的数据无法解析');
                    attemptError.status = 502;
                }

                if (!attemptError) {
                    const content =
                        data?.choices?.[0]?.message?.content?.trim();

                    if (content) {
                        // 成功获得反馈，立即结束重试
                        return content;
                    }

                    attemptError = new Error(
                        'DeepSeek 没有返回有效的反馈文字'
                    );
                    attemptError.status = 502;
                }
            }
        }

        lastError = attemptError;

        const status = Number(attemptError?.status);
        const canRetry = RETRYABLE_STATUS.has(status);

        // 400、401、402、422 等错误不适合盲目重试
        if (!canRetry || attempt === MAX_ATTEMPTS) {
            throw lastError;
        }

        const delay = RETRY_DELAYS[attempt];

        console.warn(
            `DeepSeek 第 ${attempt} 次请求失败，状态 ${status}，` +
            `${delay / 1000} 秒后自动重试`
        );

        await sleep(delay);
    }

    throw lastError || new Error('DeepSeek 请求失败');
}
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'POST') return res.status(405).json({ error: '只允许 POST 请求' });

    try {
        const {
    name, progress, taskType, level,
    praises, advices,
    errorItems,
    phraseAiExpand,
    toneExamples,
    personal
} = req.body;
        
const wordItems = Array.isArray(errorItems?.word)
    ? errorItems.word
    : [];

const phraseItems = Array.isArray(errorItems?.phrase)
    ? errorItems.phrase
    : [];

const wordErrorCount = wordItems.length;
const phraseErrorCount = phraseItems.length;

const wordReadOnlyText = wordItems.length
    ? wordItems.map(i => {
        const text = String(i.text || '').trim();
        const reason = String(i.reason || '').trim();

        return reason
            ? `- ${text}｜${reason}`
            : `- ${text}｜未填写具体错误点`;
    }).join('\n')
    : '无';

    // 短语 / 句子分成两类：默认原样保留；勾选后交给 AI 扩写

// 单词问题：老师填写的原因原样保留
const lockedWordText = wordItems.length
    ? wordItems.map(i => {
        const text = String(i.text || '').trim();
        const reason = String(i.reason || '').trim();

        const isPartialLetters =
            /^(?=.*-)[A-Za-z-]+$/.test(reason);

        return reason
            ? `【${text}】${isPartialLetters ? '的' : ''}${reason}`
            : `【${text}】`;
    }).join('、')
    : '';

// 根据总开关决定所有短语 / 句子的处理方式
const phraseInstruction = phraseAiExpand
    ? 'AI扩写：结合原句，把老师指出的错误点解释成自然、简洁的纠正性反馈；可以补充与这个知识点直接相关的解释，但不得增加其他问题。'
    : '自然整理：必须保留老师原始说明中的全部信息和原意，只允许做必要的连接、语序和标点调整，使其成为自然完整的反馈句；不得补充、扩展或推断新的知识。';

const phrasePromptText = phraseItems.length
    ? phraseItems.map((i, index) => {
        const text = String(i.text || '').trim();
        const reason = String(i.reason || '').trim();

        return `${index + 1}. 原句：【${text}】
老师指出的错误点：${reason}
处理方式：${phraseInstruction}`;
    }).join('\n\n')
    : '无';
        
        const systemPrompt = `你是一位资深、专业且极具亲和力的少儿英语教培机构"指导老师"。
请根据以下信息生成一段用于微信发送的"彩虹反馈段落"。

【格式要求】：
1. 回复直接以学生英文名切入，不要输出“家长您好”“请查收”“以下是反馈”等开头。
2. 反馈尽量控制在150字以内；如果知识点较多，优先保证知识点和练习建议完整。
3. 老师提供的具体单词、短语、句子使用中文全角方括号【】标注。
4. [[WORD_ERRORS]] 是程序专用占位符，不属于反馈文字。必须逐字符原样保留，不能改成【WORD_ERRORS】或任何其他形式，也不能在占位符外额外添加【】、引号或括号。
5. 正文以1-2段为主，不要分成很多小段。

【知识点使用规则】：
1. “单词发音问题”和“短语/句子错误点”中的所有内容，都是老师已经确认需要纠正或提醒的问题，绝对不能描述为优点、亮点、掌握得好、使用准确或“用得很到位”等正面表现。
2. 开头的肯定和夸奖只能依据“表现亮点”和整体完成情况生成，不能从错误标注内容中自行提取优点。
3. “单词发音问题只读参考”只用于帮助理解 [[WORD_ERRORS]] 中包含什么内容，以及判断其前后应该如何自然衔接。
只读参考不得直接出现在最终正文中，也不得复制、改写、删减、解释、扩展或推断其中的具体知识点。
正式反馈中的具体单词发音问题必须且只能通过 [[WORD_ERRORS]] 出现一次。
因此，在 [[WORD_ERRORS]] 前后组织语言时，要根据只读参考判断它本身已经包含的信息，避免形成重复或不通顺的句子。例如，不要写成“这几个单词 [[WORD_ERRORS]] 读得不够准确”这类替换占位符后结构不完整的表达。
“单词发音问题只读参考”属于错误信息，绝对不能用于生成开头表扬或正面评价。
4. 每个短语/句子错误点都包含“原句”“老师指出的错误点”和“处理方式”，必须严格按照对应的处理方式完成反馈。
5. 标记为“自然整理”的项目：
必须保留老师原始说明中的全部信息和原意，只允许增加必要的连接词、调整语序和标点，使内容成为自然、完整的反馈句。不得删除信息，不得补充解释、举例或推断新的知识。
6. 标记为“AI扩写”的项目：
可以结合原句，对老师明确指出的错误点进行自然、简洁的解释，但只能围绕这个错误点展开，不得增加老师没有指出的其他问题。
7. 如果老师提供的错误点比较简短，例如“which 定语从句”“should+被动结构”“介词 around”，不要自行猜测学生具体错在什么地方，只能针对老师明确指出的知识点进行提醒或解释。
8. 无论是否AI扩写，都不能自行增加发音、停顿、连读、语调、流畅度、漏读或其他语法问题，除非老师已经明确指出。

【知识点与后续文字的衔接】：
[[WORD_ERRORS]] 所代表的老师知识点是不可拆分的完整信息片段。转入短语/句子问题、另一类问题或练习建议时，要使用合适的中文标点自然衔接，不能把前后内容直接连在一起。
短语/句子错误点之间，以及具体问题与练习建议之间，也要使用清楚、完整的中文标点自然分隔。

【反馈顺序】：
正文顺序固定为：
整体表现和亮点 → 单词发音问题 → 短语/句子/语法问题 → 练习建议 → 结尾鼓励。
如果某一类没有问题，则直接跳过该类；只要同时存在单词发音问题和短语/句子问题，就必须先反馈单词发音问题，再反馈短语/句子问题。
整体要自然衔接，不要为了遵守顺序而写成机械模板。

【语言要求】：
1. 像真实老师给家长写微信反馈一样，自然、亲切、口语化，可以活泼生动并适当使用Emoji。
2. 表达可以有变化，但自然优先，不要为了追求新奇而使用夸张、网络化或突兀的说法，如“抠一抠”“焊在嘴巴里”等。
3. 不使用比喻式、过度夸张的评价。
4. 不要自行创造【出现问题的单词】【这些单词】【错误单词】等概括性方括号内容。
5. 相邻反馈可以变化开头、句式和夸奖角度，但不要求每次完全不同。
6. 正文默认采用老师直接对学生说话的语气。建议和鼓励应自然使用“你”“咱们”或直接陈述，避免使用“提醒孩子”“建议孩子”“让孩子”“学生需要”等第三方视角表达；除非老师原始知识点中明确要求保留这些词。

【单词数量与称呼规则】：
“单词发音问题数量”是程序提供的真实数量，必须严格按照该数量组织语言。
- 数量为1时，只能使用单数表达，例如“这个单词”“该单词”，或直接衔接 [[WORD_ERRORS]]；禁止使用“几个单词”“这些单词”“这几个词”“以上单词”等复数表达。
- 数量为2个及以上时，才可以使用“这些单词”“这几个单词”等复数表达。
- 不得根据 [[WORD_ERRORS]] 自行猜测数量，必须以“单词发音问题数量”为准。

【内容基调要求】：
1. 遵循肯定亮点 + 温和建议 + 期待升华。
2. 根据作业等级调整语气：完美作业要自豪，错误适中要温和引导，攻坚挑战要共情打气。
3. 绝对不要用中文音译来纠音，只需要点出读错的单词即可。
4. 【针对性练习建议】：
- 所有具体问题反馈完成后，再统一给出练习建议，并放在最后1-2句鼓励之前。
- 必须严格根据“单词发音问题数量”和“短语/句子问题数量”决定练习内容。
- 练习建议直接说明“练什么、怎么练”，不要自行添加“回家后”“课后”“今晚”“每天”“有时间时”等时间、地点或学习安排，除非老师明确提供了这些信息。

- 单词发音问题数量大于0时：
  必须给出单词发音练习，内容需包含示范音频 + 相关单词 + 每个5遍 + 巩固正确读音，语法完整、对象明确。

- 短语/句子问题数量大于0时：
  必须给出对应的语法点/短语/句子练习，包含回归原句 + 读3遍 + 加深结构/用法理解，语法完整、对象明确。

- 短语/句子问题数量为0时：
  禁止生成任何语法、短语、句子、原句、课文朗读或“加深内容理解”等额外练习建议，只能保留单词发音对应的练习。

- 单词发音问题数量为0时：
  禁止生成单词发音练习。

- 两类问题数量都大于0时，才可以同时给出两类练习建议。

- 次数写 5 遍、3 遍。
- 完整性优先于150字。
5. 【结尾鼓励】：
练习建议之后，只保留1-2句简短、自然的鼓励或期待作为结尾。不要再次总结前面的表现，不要重复知识点或练习建议，也不要连续写多句内容很接近的鼓励。
结尾可以活泼、有亲和力，但要简洁收住。
`;
        
        // 构建语气参考段落
        const toneSection = toneExamples
            ? `\n【语气参考（请模仿以下风格，但不要直接照抄）】：\n${toneExamples}`
            : '';

        const userPrompt = `学生英文名：${name || '未知'}
打卡进度：${progress || '未知'}
作业类型：${taskType || '未知'}
作业等级：${level || '未知'}
表现亮点：${praises || '无'}
建议指导：${advices || '无'}

单词发音问题数量：${wordErrorCount}
单词发音问题只读参考：
${wordReadOnlyText}
正式单词发音内容：${lockedWordText ? '[[WORD_ERRORS]]' : '无'}

短语/句子问题数量：${phraseErrorCount}

短语/句子错误点：
${phrasePromptText}

个性化观察/补充要求：${personal || '无'}${toneSection}`;

    let result = await callDeepSeekWithRetry({
    model: "deepseek-v4-flash",

    thinking: {
        type: "disabled"
    },

    messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
    ],

    temperature: 0.7,
    max_tokens: 500
});

// 防止 AI 给占位符额外套上【】
result = result
    .replaceAll('【[[WORD_ERRORS]]】', '[[WORD_ERRORS]]');

// 插入老师原始填写的单词问题
if (lockedWordText) {
    if (result.includes('[[WORD_ERRORS]]')) {

        // 如果占位符后面直接连接文字，没有标点，则自动补句号
        result = result.replace(
            /\[\[WORD_ERRORS\]\](?!\s*[。！？；，：,.!?;:])/,
            '[[WORD_ERRORS]]。'
        );

        // 插入老师原始填写的单词问题
        result = result.replace('[[WORD_ERRORS]]', lockedWordText);

        // 如果 AI 意外重复输出占位符，删除多余的
        result = result.replaceAll('[[WORD_ERRORS]]', '');

    } else {
        // AI 万一忘了占位符，仍然保证老师内容不会丢
        result += `\n${lockedWordText}`;
    }
} else {
    result = result.replaceAll('[[WORD_ERRORS]]', '');
}
res.status(200).json({ result });

    } catch (error) {
    // 真实错误只记录在 Vercel 后台
    console.error('生成出错（后台记录）:', {
        status: error?.status,
        message: error?.message,
        stack: error?.stack
    });

    const status = Number(error?.status);

    // 这些通常属于临时繁忙、超时或网络波动
    const temporaryStatuses = [429, 500, 502, 503, 504];

    if (temporaryStatuses.includes(status)) {
        return res.status(503).json({
            error: 'AI 服务暂时繁忙，系统已经自动重试 3 次，请稍后再试。'
        });
    }

    // 余额、API Key、模型参数等其他问题
    // 前台不显示具体原因
    return res.status(500).json({
        error: '生成错误'
    });
}
}
