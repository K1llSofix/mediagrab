'use strict';

/** Сообщения главного процесса на двух языках. Язык переключается из интерфейса через setLang(). */

const DICT = {
  ru: {
    'err.bot': 'YouTube просит подтвердить, что вы не бот. Нажмите «Войти в YouTube» на карточке и войдите в аккаунт Google (лучше отдельный). Если вход уже выполнен, подождите немного или отключите VPN.',
    'main.login_title': 'Вход в YouTube',
    'err.hls_fragment': 'Не удалось скачать фрагмент видеопотока. Возможно, попалась реклама или ссылка потока устарела — добавьте ссылку снова, дождитесь начала нужной серии и нажмите «Забрать видео».',
    'main.cookies_unreadable': 'Куки браузера ({browser}) прочитать не удалось, поэтому запрос шёл без входа в аккаунт. ',
    'err.cookies': 'Не удалось прочитать куки из браузера. Выберите в «Дополнительно» → «Другой способ входа» Firefox или файл cookies.txt. Chrome и Edge не поддерживаются.',
    'err.private': 'Это приватное видео. Нужен вход в аккаунт с доступом: для YouTube нажмите «Войти в YouTube».',
    'err.age': 'Видео с возрастным ограничением. Нужен вход в аккаунт: для YouTube нажмите «Войти в YouTube».',
    'err.login': 'Сайт требует вход в аккаунт. Для YouTube нажмите «Войти в YouTube». Для Instagram и других сайтов откройте «Дополнительно» → «Другой способ входа» и выберите Firefox (где вы авторизованы) или файл cookies.txt.',
    'err.geo': 'Видео недоступно в вашем регионе. Попробуйте указать прокси в «Дополнительно».',
    'err.rate': 'Сайт ограничил частоту запросов. Подождите несколько минут и повторите.',
    'err.forbidden': 'Сайт отказал в доступе (403). Обновите yt-dlp в «Дополнительно», войдите в аккаунт, включите токен подтверждения или смените прокси.',
    'err.unsupported': 'Эта ссылка не поддерживается. Проверьте, что она ведёт на конкретное видео или пост.',
    'err.format': 'Выбранное качество недоступно. Выберите другое. Если это YouTube, обновите yt-dlp («Дополнительно» → «Обновить yt-dlp»).',
    'err.unavailable': 'Видео недоступно: оно удалено, скрыто или ссылка неверна.',
    'err.jsrt': 'Не удалось пройти проверку YouTube. Обновите yt-dlp: «Дополнительно» → «Обновить yt-dlp».',
    'err.ffmpeg': 'Не удалось обработать файл через ffmpeg. Переустановите приложение или проверьте, что ffmpeg не заблокирован антивирусом.',
    'err.network': 'Нет соединения с сайтом. Проверьте интернет. Если сайт у вас блокируется, укажите прокси в «Дополнительно».',
    'err.unknown': 'Неизвестная ошибка.',

    'post.Merger': 'Склейка видео и звука…',
    'post.ExtractAudio': 'Обработка аудио…',
    'post.VideoRemuxer': 'Упаковка в MP4…',
    'post.VideoConvertor': 'Конвертация видео…',
    'post.Metadata': 'Запись метаданных…',
    'post.FFmpegMetadata': 'Запись метаданных…',
    'post.EmbedThumbnail': 'Добавление обложки…',
    'post.MoveFiles': 'Сохранение файла…',
    'post.default': 'Обработка…',

    'proc.aborted': 'Отменено',
    'proc.timeout': 'Превышено время ожидания ответа',

    'yt.download_failed': 'Не удалось скачать {what} (HTTP {status}). Проверьте интернет и доступ к github.com.',
    'yt.update_failed': 'Не удалось обновить yt-dlp',
    'yt.bad_format': 'Неизвестный формат',
    'yt.bad_quality': 'Неверное качество',
    'yt.bad_bitrate': 'Неверный битрейт',
    'yt.bad_time': 'Неверное время фрагмента. Используйте форматы 90, 1:30 или 1:02:30.',
    'yt.parse_failed': 'Не удалось разобрать ответ yt-dlp',
    'yt.empty': 'Пустой ответ yt-dlp',
    'yt.exit_code': 'yt-dlp завершился с кодом {code}',
    'zip.failed': 'Не удалось распаковать архив: {why}',

    'main.dl_ytdlp': 'Первый запуск: загружаю yt-dlp…',
    'main.dl_deno': 'Первый запуск: загружаю JS-движок для YouTube…',
    'main.check_update': 'Проверяю обновления yt-dlp…',
    'main.not_link': 'Это не ссылка. Она должна начинаться с http:// или https://',
    'main.bad_link': 'Некорректная ссылка',
    'main.cancelled': 'Отменено',
    'err.vk_private': 'Это видео VK доступно только вошедшим пользователям, друзьям или по особой ссылке. Откройте «Дополнительно» → «Аккаунт и сеть» → «Другой способ входа» и выберите Firefox (где вы вошли в VK) или файл cookies.txt.',
    'yt.checksum_failed': 'Загруженный файл {what} не совпал с контрольной суммой релиза и удалён. Повторите попытку; если ошибка остаётся, проверьте прокси или антивирус.',
    'main.dlg_report': 'Сохранить отчёт об ошибке',
    'main.update_busy': 'Дождитесь окончания загрузок: во время загрузки yt-dlp обновить нельзя.',
    'main.tray_open': 'Открыть MediaGrab', 'main.tray_quit': 'Выход',
    'main.cookies_notice': 'Куки браузера прочитать не удалось, ссылка открыта без входа в аккаунт.',
    'main.no_folder': 'Не выбрана папка для сохранения',
    'main.image_no_url': 'Не нашёл адрес изображения',
    'main.image_failed': 'Не удалось скачать изображение: {msg}',
    'main.start_failed': 'Не удалось запустить yt-dlp: {msg}',
    'main.subs_skipped': 'Субтитры не скачались (лимит YouTube). Качаю видео без них…',
    'pot.unsupported': 'Для этой системы нет готовой программы-генератора токенов.',
    'pot.bad_plugin': 'В архиве плагина не нашлась нужная папка. Возможно, формат изменился.',
    'pot.server_failed': 'Генератор токенов не запустился.',
    'yt.gif_clip': 'Для GIF выберите фрагмент не длиннее {max} секунд: укажите начало и конец.',
    'main.gif_making': 'Создаю GIF…',
    'main.gif_failed': 'Не удалось создать GIF: {msg}',
    'main.cooldown': 'Сайт ограничил частоту запросов. Общая пауза {s} с, чтобы не усугублять…',
    'main.login_pause': 'Пауза {s} с: так аккаунт реже попадает под ограничения…',
    'main.login_cap': 'Достигнут лимит безопасности: за последний час уже много загрузок с аккаунтом. Подождите примерно {min} мин.',
    'main.retry_in': 'Сбой сети. Повтор через {s} с (попытка {n} из {max})…',
    'main.not_ready': 'yt-dlp ещё не готов',
    'main.dlg_folder': 'Папка для сохранения',
    'main.dlg_cookies': 'Файл cookies.txt',
    'main.dlg_text': 'Текстовый файл',
    'main.dlg_all': 'Все файлы',
  },
  en: {
    'err.bot': "YouTube asks you to confirm you're not a bot. Press “Sign in to YouTube” on the card and sign in with a Google account (a separate one is best). If you already did, wait a bit or turn off your VPN.",
    'main.login_title': 'Sign in to YouTube',
    'err.hls_fragment': 'Could not download a stream fragment. An ad may have been captured or the stream token expired — add the link again, wait for the episode to start playing, and click “Capture video”.',
    'main.cookies_unreadable': "Couldn't read cookies from the browser ({browser}), so the request was made without signing in. ",
    'err.cookies': "Couldn't read cookies from the browser. In Advanced → “Another way to sign in” choose Firefox or a cookies.txt file. Chrome and Edge aren't supported.",
    'err.private': 'This video is private. Sign in with an account that has access: for YouTube press “Sign in to YouTube”.',
    'err.age': 'Age-restricted video. Sign in to continue: for YouTube press “Sign in to YouTube”.',
    'err.login': 'The site requires you to sign in. For YouTube press “Sign in to YouTube”. For Instagram and other sites open Advanced → “Another way to sign in” and choose Firefox (where you are signed in) or a cookies.txt file.',
    'err.geo': 'This video is not available in your region. Try setting a proxy in “Advanced”.',
    'err.rate': 'The site is rate-limiting requests. Wait a few minutes and try again.',
    'err.forbidden': 'The site denied access (403). Update yt-dlp in Advanced, sign in, enable the PO token experiment or change the proxy.',
    'err.unsupported': 'This link is not supported. Make sure it points to a specific video or post.',
    'err.format': 'The selected quality is unavailable. Pick another one. For YouTube, update yt-dlp (Advanced → Update yt-dlp).',
    'err.unavailable': 'The video is unavailable: it was removed, hidden, or the link is wrong.',
    'err.jsrt': "Couldn't pass YouTube's check. Update yt-dlp: Advanced → Update yt-dlp.",
    'err.ffmpeg': "Couldn't process the file with ffmpeg. Reinstall the app or check that antivirus isn't blocking ffmpeg.",
    'err.network': 'Cannot reach the site. Check your internet. If the site is blocked for you, set a proxy in “Advanced”.',
    'err.unknown': 'Unknown error.',

    'post.Merger': 'Merging video and audio…',
    'post.ExtractAudio': 'Processing audio…',
    'post.VideoRemuxer': 'Packing into MP4…',
    'post.VideoConvertor': 'Converting video…',
    'post.Metadata': 'Writing metadata…',
    'post.FFmpegMetadata': 'Writing metadata…',
    'post.EmbedThumbnail': 'Adding cover art…',
    'post.MoveFiles': 'Saving the file…',
    'post.default': 'Processing…',

    'proc.aborted': 'Cancelled',
    'proc.timeout': 'Timed out waiting for a response',

    'yt.download_failed': "Couldn't download {what} (HTTP {status}). Check your internet and access to github.com.",
    'yt.update_failed': "Couldn't update yt-dlp",
    'yt.bad_format': 'Unknown format',
    'yt.bad_quality': 'Invalid quality',
    'yt.bad_bitrate': 'Invalid bitrate',
    'yt.bad_time': 'Invalid clip time. Use 90, 1:30 or 1:02:30.',
    'yt.parse_failed': "Couldn't parse the yt-dlp response",
    'yt.empty': 'Empty yt-dlp response',
    'yt.exit_code': 'yt-dlp exited with code {code}',
    'zip.failed': "Couldn't unpack the archive: {why}",

    'main.dl_ytdlp': 'First launch: downloading yt-dlp…',
    'main.dl_deno': 'First launch: downloading the JS engine for YouTube…',
    'main.check_update': 'Checking for yt-dlp updates…',
    'main.not_link': 'This is not a link. It must start with http:// or https://',
    'main.bad_link': 'Invalid link',
    'main.cancelled': 'Cancelled',
    'err.vk_private': 'This VK video is only available to signed-in users, friends, or via a special link. Open Advanced → Account and network → “Another way to sign in” and choose Firefox (where you are signed in to VK) or a cookies.txt file.',
    'yt.checksum_failed': 'The downloaded {what} file did not match the release checksum and was removed. Try again; if it keeps happening, check your proxy or antivirus.',
    'main.dlg_report': 'Save error report',
    'main.update_busy': 'Wait for the downloads to finish: yt-dlp cannot be updated while they run.',
    'main.tray_open': 'Open MediaGrab', 'main.tray_quit': 'Quit',
    'main.cookies_notice': "Couldn't read browser cookies, so the link was opened without signing in.",
    'main.no_folder': 'No save folder selected',
    'main.image_no_url': "Couldn't find the image address",
    'main.image_failed': "Couldn't download the image: {msg}",
    'main.start_failed': "Couldn't start yt-dlp: {msg}",
    'main.subs_skipped': "Subtitles couldn't be downloaded (YouTube rate limit). Downloading the video without them…",
    'pot.unsupported': 'There is no ready-made token generator for this system.',
    'pot.bad_plugin': "The plugin archive doesn't contain the expected folder. The format may have changed.",
    'pot.server_failed': "The token generator didn't start.",
    'yt.gif_clip': 'For a GIF pick a clip of at most {max} seconds: set both the start and the end.',
    'main.gif_making': 'Making the GIF…',
    'main.gif_failed': "Couldn't make the GIF: {msg}",
    'main.cooldown': 'The site is rate-limiting requests. Shared pause of {s} s to avoid making it worse…',
    'main.login_pause': 'Pausing {s} s: this keeps the account from hitting limits…',
    'main.login_cap': 'Safety limit reached: too many downloads with the account in the last hour. Wait about {min} min.',
    'main.retry_in': 'Network error. Retrying in {s} s (attempt {n} of {max})…',
    'main.not_ready': 'yt-dlp is not ready yet',
    'main.dlg_folder': 'Save folder',
    'main.dlg_cookies': 'cookies.txt file',
    'main.dlg_text': 'Text file',
    'main.dlg_all': 'All files',
  },
};

Object.assign(DICT, require('./messages.more'));

let current = 'ru';

function setLang(lang) {
  current = DICT[lang] ? lang : 'en';
}

function getLang() {
  return current;
}

function t(key, params) {
  const s = (DICT[current] && DICT[current][key]) ?? DICT.en[key] ?? DICT.ru[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => (params[k] == null ? '' : String(params[k]))) : s;
}

module.exports = { t, setLang, getLang, DICT };
