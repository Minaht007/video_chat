const express = require("express");
const path = require("path");
const fs = require("fs");
const fileUpload = require("express-fileupload");
const dotenv = require("dotenv");

// Загрузка переменных окружения
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const CLEANUP_DELAY = (process.env.MEETING_CLEANUP_DELAY || 60) * 1000;

// -------------------
// ИНИЦИАЛИЗАЦИЯ
// -------------------

let server = app.listen(PORT, () => {
	console.log(`✅ Server listening on port ${PORT}`);
});

const io = require("socket.io")(server, {
	allowEIO3: true,
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// -------------------
// ГЛОБАЛЬНЫЕ СТРУКТУРЫ
// -------------------

let userConnections = []; // все подключения
const activeMeetings = new Map(); // meeting_id -> { users: [], timer: Timeout }

// -------------------
// SOCKET.IO
// -------------------

io.on("connection", (socket) => {
	console.log("⚡ Socket connected:", socket.id);

	socket.on("userconnect", (data) => {
		const meetingId = data.meetingid;
		const userName = data.displayName;

		console.log(`👥 ${userName} подключился к ${meetingId}`);

		// Добавляем в userConnections
		userConnections.push({
			connectionId: socket.id,
			user_id: userName,
			meeting_id: meetingId,
		});

		// Управление активными комнатами
		if (!activeMeetings.has(meetingId)) {
			activeMeetings.set(meetingId, { users: [socket.id], timer: null });
		} else {
			const meeting = activeMeetings.get(meetingId);
			meeting.users.push(socket.id);

			// Если ранее был таймер очистки — отменяем
			if (meeting.timer) {
				clearTimeout(meeting.timer);
				meeting.timer = null;
			}
		}

		// Находим других участников комнаты
		const otherUsers = userConnections.filter(
			(p) => p.meeting_id === meetingId && p.connectionId !== socket.id
		);

		// Оповещаем существующих
		otherUsers.forEach((v) => {
			socket.to(v.connectionId).emit("inform_other_about_me", {
				other_user_id: userName,
				connId: socket.id,
				userNumber: otherUsers.length + 1,
			});
		});

		// Сообщаем новому пользователю о других
		socket.emit("inform_me_about_other_user", otherUsers);
	});

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
	// Обработка WebRTC SDP
	socket.on("SDPProcess", (data) => {
		io.to(data.to_connId).emit("SDPProcess", {
			message: data.message,
			from_connid: socket.id,
		});
	});
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
	// Чат-сообщения
	socket.on("sendMessage", (msg) => {
		const mUser = userConnections.find((p) => p.connectionId === socket.id);
		if (!mUser) return;

		// Проверка на пустое сообщение
		if (!msg || typeof msg !== "string" || msg.trim().length === 0) {
			socket.emit("errorMessage", "The message cannot be empty.");
			return;
		}

		// Очистка HTML и потенциально опасных символов (XSS)
		const sanitizeMessage = (text) => {
			return text
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;")
				.replace(/'/g, "&#039;")
				.replace(/`/g, "&#096;");
		};

		const safeMessage = sanitizeMessage(msg.trim());

		// Если после очистки строка пуста (например, было <script>), то не отправляем
		if (safeMessage.length === 0) {
			socket.emit("errorMessage", "The message cannot contain only HTML or scripts.");
			return;
		}

		const meetingId = mUser.meeting_id;
		const from = mUser.user_id;
		const list = userConnections.filter((p) => p.meeting_id === meetingId);

		// Рассылаем безопасное сообщение
		list.forEach((v) => {
			socket.to(v.connectionId).emit("showChatMessage", {
				from,
				message: safeMessage,
			});
		});
	});
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
	// Передача файлов между пользователями
	socket.on("fileTransferToOther", (msg) => {
		const mUser = userConnections.find((p) => p.connectionId === socket.id);
		if (!mUser) return;

		const meetingId = mUser.meeting_id;
		const list = userConnections.filter((p) => p.meeting_id === meetingId);

		list.forEach((v) => {
			socket.to(v.connectionId).emit("showFileMessage", {
				username: msg.username,
				meetingid: msg.meetingid,
				filePath: msg.filePath,
				fileName: msg.fileName,
			});
		});
	});
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
	// Отключение пользователя
	socket.on("disconnect", () => {
		console.log("❌ Disconnected:", socket.id);

		const disUser = userConnections.find((p) => p.connectionId === socket.id);
		if (!disUser) return;

		const meetingId = disUser.meeting_id;
		userConnections = userConnections.filter((p) => p.connectionId !== socket.id);

		const meeting = activeMeetings.get(meetingId);
		if (meeting) {
			meeting.users = meeting.users.filter((id) => id !== socket.id);

			// Оповещение остальных
			const list = userConnections.filter((p) => p.meeting_id === meetingId);
			list.forEach((v) => {
				const userNumberAfterUserLeave = list.length;  // Исправьте на list.length (без -1, как в старой — там возможная ошибка, но используйте длину комнаты)
				socket.to(v.connectionId).emit("inform_other_about_disconnect_user", {
					connId: socket.id,
					uNumber: userNumberAfterUserLeave,
				});
			});

			// Если никого не осталось — ставим таймер на очистку
			if (meeting.users.length === 0) {
				console.log(`🕒 Комната ${meetingId} пуста. Удаление через ${CLEANUP_DELAY / 1000} сек.`);
				meeting.timer = setTimeout(() => {
					cleanupMeetingData(meetingId);
					activeMeetings.delete(meetingId);
				}, CLEANUP_DELAY);
			}
		}
	});
});

// -------------------
// ЗАГРУЗКА ФАЙЛОВ
// -------------------

app.post("/attachimg", (req, res) => {
	if (!req.files || Object.keys(req.files).length === 0) {
		return res.status(400).send("There are no files to upload.");
	}

	const data = req.body;
	const imageFile = req.files.zipfile;

	// Проверяем расширения
	const allowedExtensions = [".png", ".jpg", ".jpeg", ".gif", ".zip", ".pdf"];
	const allowedMimes = [
		"image/png",
		"image/jpeg",
		"image/gif",
		"application/zip",
		"application/pdf",
	];

	const ext = path.extname(imageFile.name).toLowerCase();
	if (!allowedExtensions.includes(ext) || !allowedMimes.includes(imageFile.mimetype)) {
		return res.status(400).send("Invalid file type.");
	}

	// Создаём папку для встречи
	const dir = path.join(__dirname, "public", "attachment", data.meeting_id);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

	const filePath = path.join(dir, imageFile.name);

	imageFile.mv(filePath, (error) => {
		if (error) {
			console.error("File upload error:", error);
			return res.status(500).send(error);
		} else {
			console.log(`📁 Файл загружен: ${filePath}`);
			res.send("File uploaded successfully!");
		}
	});
});

// -------------------
// ФУНКЦИЯ ОЧИСТКИ
// -------------------

function cleanupMeetingData(meetingId) {
	const dir = path.join(__dirname, "public", "attachment", meetingId);

	fs.rm(dir, { recursive: true, force: true }, (err) => {
		if (err) console.error(`Ошибка при удалении ${meetingId}:`, err);
		else console.log(`🧹 Meeting ${meetingId} очищен.`);
	});

	userConnections = userConnections.filter((p) => p.meeting_id !== meetingId);
}

// -------------------
// ОЧИСТКА ПРИ СТАРТЕ СЕРВЕРА
// -------------------

const attachmentRoot = path.join(__dirname, "public", "attachment");
if (fs.existsSync(attachmentRoot)) {
	fs.readdirSync(attachmentRoot).forEach(folder => {
		const dir = path.join(attachmentRoot, folder);
		fs.rmSync(dir, { recursive: true, force: true });
	});
	console.log("🧼 Старые данные очищены при запуске сервера.");
}